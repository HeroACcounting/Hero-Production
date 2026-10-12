import { parseBankCsv, parseBankOfx } from '../src/modules/banking/csv-import.util';
import { ReconciliationService } from '../src/modules/banking/reconciliation.service';

describe('parseBankCsv', () => {
  it('parses Date/Description/Amount headers', () => {
    const csv = [
      'Date,Description,Amount',
      '2024-01-15,Salary deposit,2500.00',
      '15/02/2024,Office supplies,-45.50',
    ].join('\n');
    const { rows, errors } = parseBankCsv(csv);
    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      date: '2024-01-15',
      description: 'Salary deposit',
      amount: '2500.00',
    });
    expect(rows[1].date).toBe('2024-02-15');
    expect(rows[1].amount).toBe('-45.50');
  });

  it('handles Debit/Credit columns', () => {
    const csv = [
      'Transaction Date,Narration,Debit,Credit',
      '2024-03-01,ATM withdrawal,100.00,',
      '2024-03-02,Client payment,,500.00',
    ].join('\n');
    const { rows, errors } = parseBankCsv(csv);
    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(2);
    expect(rows[0].amount).toBe('-100.00');
    expect(rows[1].amount).toBe('500.00');
  });

  it('reports unrecognised dates', () => {
    const csv = 'Date,Description,Amount\nbad-date,x,10\n';
    const { rows, errors } = parseBankCsv(csv);
    expect(rows).toHaveLength(0);
    expect(errors.some((e) => /unrecognised date/i.test(e))).toBe(true);
  });

  it('rejects empty or header-only files', () => {
    const { rows, errors } = parseBankCsv('Date,Description,Amount\n');
    expect(rows).toHaveLength(0);
  });
});

describe('parseBankOfx', () => {
  it('parses STMTTRN blocks', () => {
    const ofx = `
      <STMTTRN>
      <DTPOSTED>20240115
      <TRNAMT>100.50
      <MEMO>Test deposit
      </STMTTRN>
    `;
    const { rows, errors } = parseBankOfx(ofx);
    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2024-01-15');
    expect(rows[0].amount).toBe('100.50');
  });
});

describe('ReconciliationService.fingerprint', () => {
  it('is stable for same logical transaction', () => {
    const a = ReconciliationService.fingerprint(
      'acct-1',
      '2024-01-15T00:00:00Z',
      '100.5',
      '  Coffee Shop  ',
    );
    const b = ReconciliationService.fingerprint(
      'acct-1',
      '2024-01-15',
      '100.50',
      'coffee shop',
    );
    expect(a).toBe(b);
  });

  it('differs when amount differs', () => {
    const a = ReconciliationService.fingerprint('a', '2024-01-01', '10.00', 'x');
    const b = ReconciliationService.fingerprint('a', '2024-01-01', '10.01', 'x');
    expect(a).not.toBe(b);
  });
});
