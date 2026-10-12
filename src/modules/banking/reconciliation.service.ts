import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { getPool } from '../../db/pool';
import { LedgerService } from '../ledger/ledger.service';
import { BankAccountService } from './bank-account.service';
import { getInvoiceBalance, getBillBalance, recomputeInvoiceStatus, recomputeBillStatus } from '../payments/balance.util';

export interface ImportTransactionInput {
  date: string;
  description: string;
  amount: string;
}

@Injectable()
export class ReconciliationService {
  constructor(
    private ledgerService: LedgerService,
    private bankAccountService: BankAccountService,
  ) {}

  /**
   * Stable fingerprint for deduplication across repeated imports.
   * account + calendar day + amount + normalized description.
   */
  static fingerprint(
    bankAccountId: string,
    date: string,
    amount: string,
    description: string,
  ): string {
    const day = date.slice(0, 10);
    const amt = Number(amount).toFixed(2);
    const desc = description.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
    return `${bankAccountId}|${day}|${amt}|${desc}`;
  }

  async importTransactions(
    organizationId: string,
    bankAccountId: string,
    transactions: ImportTransactionInput[],
    options?: { source?: string },
  ) {
    await this.bankAccountService.getGlAccountCode(organizationId, bankAccountId);

    const pool = getPool();
    const client = await pool.connect();
    const inserted: { id: string }[] = [];
    let duplicatesSkipped = 0;
    const source = options?.source || 'csv';

    try {
      await client.query('BEGIN');
      for (const txn of transactions) {
        const fp = ReconciliationService.fingerprint(
          bankAccountId,
          txn.date,
          txn.amount,
          txn.description,
        );
        const existing = await client.query(
          `SELECT id FROM bank_transactions
           WHERE organization_id = $1 AND bank_account_id = $2 AND import_fingerprint = $3
           LIMIT 1`,
          [organizationId, bankAccountId, fp],
        );
        if (existing.rows.length > 0) {
          duplicatesSkipped += 1;
          continue;
        }
        const result = await client.query(
          `INSERT INTO bank_transactions
             (organization_id, bank_account_id, txn_date, description, amount, import_fingerprint, import_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [organizationId, bankAccountId, txn.date, txn.description, txn.amount, fp, source],
        );
        inserted.push(result.rows[0]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return {
      imported: inserted.length,
      duplicatesSkipped,
      ids: inserted.map((r) => r.id),
    };
  }

  async listForOrg(organizationId: string, bankAccountId?: string) {
    const pool = getPool();
    const result = bankAccountId
      ? await pool.query(
          `SELECT id, txn_date, description, amount, status, matched_invoice_id, matched_bill_id
           FROM bank_transactions WHERE organization_id = $1 AND bank_account_id = $2
           ORDER BY txn_date DESC`,
          [organizationId, bankAccountId],
        )
      : await pool.query(
          `SELECT id, txn_date, description, amount, status, matched_invoice_id, matched_bill_id
           FROM bank_transactions WHERE organization_id = $1 ORDER BY txn_date DESC`,
          [organizationId],
        );
    return result.rows;
  }

  private async getTxnOrThrow(organizationId: string, txnId: string) {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM bank_transactions WHERE id = $1 AND organization_id = $2`,
      [txnId, organizationId],
    );
    if (result.rows.length === 0) throw new NotFoundException('Bank transaction not found');
    return result.rows[0];
  }

  /** Matches a deposit to an invoice, applying the transaction's full
   * amount as ONE payment against that invoice. Supports partial payment
   * of the invoice (the invoice may still owe a remaining balance and
   * stay PARTIALLY_PAID, to be closed out by a later transaction) but
   * does NOT support splitting a single transaction across multiple
   * invoices, or a transaction that overpays an invoice — both are
   * documented gaps (see docs/TESTING.md). */
  async matchToInvoice(organizationId: string, txnId: string, invoiceId: string) {
    const txn = await this.getTxnOrThrow(organizationId, txnId);
    if (txn.status !== 'UNMATCHED') {
      throw new BadRequestException(`Transaction is already ${txn.status}, cannot match again`);
    }
    if (parseFloat(txn.amount) <= 0) {
      throw new BadRequestException('Only deposits (positive amounts) can be matched to an invoice');
    }

    const pool = getPool();
    const invoiceResult = await pool.query(
      `SELECT id, status FROM invoices WHERE id = $1 AND organization_id = $2`,
      [invoiceId, organizationId],
    );
    if (invoiceResult.rows.length === 0) throw new NotFoundException('Invoice not found');
    const invoice = invoiceResult.rows[0];

    if (invoice.status !== 'SENT' && invoice.status !== 'PARTIALLY_PAID') {
      throw new BadRequestException(
        `Invoice must be SENT or PARTIALLY_PAID to receive a payment (current status: ${invoice.status})`,
      );
    }

    const balance = await getInvoiceBalance(pool, organizationId, invoiceId);
    const txnAmount = parseFloat(txn.amount);
    const remaining = parseFloat(balance.remaining);
    if (txnAmount - remaining > 0.005) {
      throw new BadRequestException(
        `Transaction amount (${txn.amount}) exceeds the invoice's remaining balance (${balance.remaining}). Overpayment handling is not yet implemented — the transaction amount must be less than or equal to what's still owed.`,
      );
    }

    const bankGlCode = await this.bankAccountService.getGlAccountCode(organizationId, txn.bank_account_id);

    const journalResult = await this.ledgerService.postEntry({
      organizationId,
      entryDate: new Date(txn.txn_date),
      description: `Payment received for invoice ${invoiceId}`,
      sourceType: 'BANK_MATCH_INVOICE',
      sourceId: txnId,
      lines: [
        { accountCode: bankGlCode, debit: txn.amount, memo: 'Customer payment received' },
        { accountCode: '1-1200', credit: txn.amount, memo: 'Accounts Receivable cleared' },
      ],
    });

    await pool.query(
      `INSERT INTO payments (organization_id, invoice_id, amount, payment_date, bank_transaction_id, journal_entry_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [organizationId, invoiceId, txn.amount, txn.txn_date, txnId, journalResult.id],
    );
    const newStatus = await recomputeInvoiceStatus(pool, organizationId, invoiceId);

    await pool.query(
      `UPDATE bank_transactions SET status = 'MATCHED', matched_invoice_id = $1, journal_entry_id = $2 WHERE id = $3`,
      [invoiceId, journalResult.id, txnId],
    );

    return {
      transactionId: txnId,
      journalEntryId: journalResult.id,
      status: 'MATCHED',
      invoiceStatus: newStatus,
    };
  }

  /** Mirrors matchToInvoice for the purchase side. */
  async matchToBill(organizationId: string, txnId: string, billId: string) {
    const txn = await this.getTxnOrThrow(organizationId, txnId);
    if (txn.status !== 'UNMATCHED') {
      throw new BadRequestException(`Transaction is already ${txn.status}, cannot match again`);
    }
    if (parseFloat(txn.amount) >= 0) {
      throw new BadRequestException('Only withdrawals (negative amounts) can be matched to a bill');
    }

    const pool = getPool();
    const billResult = await pool.query(
      `SELECT id, status FROM bills WHERE id = $1 AND organization_id = $2`,
      [billId, organizationId],
    );
    if (billResult.rows.length === 0) throw new NotFoundException('Bill not found');
    const bill = billResult.rows[0];

    if (bill.status !== 'APPROVED' && bill.status !== 'PARTIALLY_PAID') {
      throw new BadRequestException(
        `Bill must be APPROVED or PARTIALLY_PAID to receive a payment (current status: ${bill.status})`,
      );
    }

    const balance = await getBillBalance(pool, organizationId, billId);
    const absAmount = Math.abs(parseFloat(txn.amount));
    const remaining = parseFloat(balance.remaining);
    if (absAmount - remaining > 0.005) {
      throw new BadRequestException(
        `Transaction amount (${txn.amount}) exceeds the bill's remaining balance (${balance.remaining}). Overpayment handling is not yet implemented.`,
      );
    }
    const absAmountStr = absAmount.toFixed(2);

    const bankGlCode = await this.bankAccountService.getGlAccountCode(organizationId, txn.bank_account_id);

    const journalResult = await this.ledgerService.postEntry({
      organizationId,
      entryDate: new Date(txn.txn_date),
      description: `Payment made for bill ${billId}`,
      sourceType: 'BANK_MATCH_BILL',
      sourceId: txnId,
      lines: [
        { accountCode: '2-1000', debit: absAmountStr, memo: 'Accounts Payable cleared' },
        { accountCode: bankGlCode, credit: absAmountStr, memo: 'Payment to supplier' },
      ],
    });

    await pool.query(
      `INSERT INTO payments (organization_id, bill_id, amount, payment_date, bank_transaction_id, journal_entry_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [organizationId, billId, absAmountStr, txn.txn_date, txnId, journalResult.id],
    );
    const newStatus = await recomputeBillStatus(pool, organizationId, billId);

    await pool.query(
      `UPDATE bank_transactions SET status = 'MATCHED', matched_bill_id = $1, journal_entry_id = $2 WHERE id = $3`,
      [billId, journalResult.id, txnId],
    );

    return {
      transactionId: txnId,
      journalEntryId: journalResult.id,
      status: 'MATCHED',
      billStatus: newStatus,
    };
  }

  async categorize(organizationId: string, txnId: string, accountCode: string) {
    const txn = await this.getTxnOrThrow(organizationId, txnId);
    if (txn.status !== 'UNMATCHED') {
      throw new BadRequestException(`Transaction is already ${txn.status}, cannot categorize again`);
    }

    const bankGlCode = await this.bankAccountService.getGlAccountCode(organizationId, txn.bank_account_id);
    const amount = parseFloat(txn.amount);
    const absAmount = Math.abs(amount).toFixed(2);

    const lines =
      amount > 0
        ? [
            { accountCode: bankGlCode, debit: absAmount, memo: txn.description },
            { accountCode, credit: absAmount, memo: txn.description },
          ]
        : [
            { accountCode, debit: absAmount, memo: txn.description },
            { accountCode: bankGlCode, credit: absAmount, memo: txn.description },
          ];

    const journalResult = await this.ledgerService.postEntry({
      organizationId,
      entryDate: new Date(txn.txn_date),
      description: `Categorized: ${txn.description}`,
      sourceType: 'BANK_CATEGORIZE',
      sourceId: txnId,
      lines,
    });

    const pool = getPool();
    const acctResult = await pool.query(
      `SELECT id FROM accounts WHERE organization_id = $1 AND code = $2`,
      [organizationId, accountCode],
    );
    await pool.query(
      `UPDATE bank_transactions SET status = 'MATCHED', categorized_account_id = $1, journal_entry_id = $2 WHERE id = $3`,
      [acctResult.rows[0]?.id ?? null, journalResult.id, txnId],
    );

    return { transactionId: txnId, journalEntryId: journalResult.id, status: 'MATCHED' };
  }

  async reconcile(organizationId: string, txnId: string) {
    const txn = await this.getTxnOrThrow(organizationId, txnId);
    if (txn.status !== 'MATCHED') {
      throw new BadRequestException(
        `Only a MATCHED transaction can be reconciled (current status: ${txn.status})`,
      );
    }
    const pool = getPool();
    await pool.query(`UPDATE bank_transactions SET status = 'RECONCILED' WHERE id = $1`, [txnId]);
    return { transactionId: txnId, status: 'RECONCILED' };
  }

  async unmatch(organizationId: string, txnId: string) {
    const txn = await this.getTxnOrThrow(organizationId, txnId);
    if (txn.status !== 'MATCHED') {
      throw new BadRequestException(
        `Only a MATCHED (not yet reconciled) transaction can be unmatched (current status: ${txn.status})`,
      );
    }

    if (txn.journal_entry_id) {
      await this.ledgerService.reverseEntry(organizationId, txn.journal_entry_id, 'Unmatched by user');
    }

    const pool = getPool();

    // Remove the specific payment this transaction created (if any — a
    // pure categorization has no payment row) and recompute the
    // invoice/bill's status from whatever payments genuinely remain,
    // rather than assuming it reverts all the way to SENT/APPROVED. This
    // matters once partial payments are involved: unmatching the second
    // of two part-payments should leave the document PARTIALLY_PAID, not
    // wipe out the first payment's effect.
    if (txn.matched_invoice_id) {
      await pool.query(`DELETE FROM payments WHERE bank_transaction_id = $1`, [txnId]);
      await recomputeInvoiceStatus(pool, organizationId, txn.matched_invoice_id);
    }
    if (txn.matched_bill_id) {
      await pool.query(`DELETE FROM payments WHERE bank_transaction_id = $1`, [txnId]);
      await recomputeBillStatus(pool, organizationId, txn.matched_bill_id);
    }

    await pool.query(
      `UPDATE bank_transactions
       SET status = 'UNMATCHED', matched_invoice_id = NULL, matched_bill_id = NULL,
           categorized_account_id = NULL, journal_entry_id = NULL
       WHERE id = $1`,
      [txnId],
    );

    return { transactionId: txnId, status: 'UNMATCHED' };
  }
}
