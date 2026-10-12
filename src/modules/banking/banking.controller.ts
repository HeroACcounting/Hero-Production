import { Body, Controller, Get, Param, Post, Query, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { IsArray, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { BankAccountService } from './bank-account.service';
import { ReconciliationService } from './reconciliation.service';
import { parseBankCsv, parseBankOfx } from './csv-import.util';
import { CountryProviderRegistry } from '../country/country-provider.registry';

class CreateBankAccountDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  currency?: string;
}

class ImportTransactionDto {
  @IsString()
  date!: string;

  @IsString()
  description!: string;

  @IsString()
  amount!: string;
}

class ImportTransactionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportTransactionDto)
  transactions!: ImportTransactionDto[];
}

class ImportFileDto {
  /** Raw CSV or OFX file contents (client reads the file and posts text). */
  @IsString()
  content!: string;

  @IsIn(['csv', 'ofx'])
  format!: 'csv' | 'ofx';
}

class MatchInvoiceDto {
  @IsString()
  invoiceId!: string;
}

class MatchBillDto {
  @IsString()
  billId!: string;
}

class CategorizeDto {
  @IsString()
  accountCode!: string;
}

@Controller('api/v1/bank-accounts')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BankAccountsController {
  constructor(
    private bankAccountService: BankAccountService,
    private reconciliationService: ReconciliationService,
    private countryRegistry: CountryProviderRegistry,
  ) {}

  @Post()
  @RequirePermission('bank.import')
  async create(@Req() req: any, @Body() dto: CreateBankAccountDto) {
    const pool = (await import('../../db/pool')).getPool();
    const org = await pool.query(`SELECT country_code FROM organizations WHERE id = $1`, [req.membership.organizationId]);
    const defaultCurrency = this.countryRegistry.get(org.rows[0]?.country_code || 'AU').defaultCurrency;
    const account = await this.bankAccountService.create(
      req.membership.organizationId,
      dto.name,
      dto.currency || defaultCurrency,
    );
    return { success: true, data: account };
  }

  @Get()
  @RequirePermission('bank.read')
  async list(@Req() req: any) {
    const accounts = await this.bankAccountService.listForOrg(req.membership.organizationId);
    return { success: true, data: accounts };
  }

  @Post(':id/transactions/import')
  @RequirePermission('bank.import')
  async importTransactions(
    @Req() req: any,
    @Param('id') bankAccountId: string,
    @Body() dto: ImportTransactionsDto,
  ) {
    const result = await this.reconciliationService.importTransactions(
      req.membership.organizationId,
      bankAccountId,
      dto.transactions,
    );
    return { success: true, data: result };
  }

  /**
   * Preview a bank statement (CSV or OFX) without committing transactions.
   * Client reads the file as text and posts content + format.
   */
  @Post(':id/statements/preview')
  @RequirePermission('bank.import')
  async previewStatement(
    @Req() req: any,
    @Param('id') bankAccountId: string,
    @Body() dto: ImportFileDto,
  ) {
    // Verify account belongs to org
    await this.bankAccountService.getGlAccountCode(
      req.membership.organizationId,
      bankAccountId,
    );
    if (!dto.content || dto.content.length > 20 * 1024 * 1024) {
      throw new BadRequestException('Statement file exceeds the 20 MB limit or is empty.');
    }
    const parsed =
      dto.format === 'ofx' ? parseBankOfx(dto.content) : parseBankCsv(dto.content);
    return {
      success: true,
      data: {
        rows: parsed.rows.slice(0, 500),
        rowCount: parsed.rows.length,
        parseErrors: parsed.errors.slice(0, 50),
        parseErrorCount: parsed.errors.length,
        truncated: parsed.rows.length > 500,
      },
    };
  }

  /** Import from a CSV or OFX bank statement (file contents as text). */
  @Post(':id/transactions/import-file')
  @RequirePermission('bank.import')
  async importFile(
    @Req() req: any,
    @Param('id') bankAccountId: string,
    @Body() dto: ImportFileDto,
  ) {
    await this.bankAccountService.getGlAccountCode(
      req.membership.organizationId,
      bankAccountId,
    );
    if (!dto.content || dto.content.length > 20 * 1024 * 1024) {
      throw new BadRequestException('Statement file exceeds the 20 MB limit or is empty.');
    }
    const parsed =
      dto.format === 'ofx' ? parseBankOfx(dto.content) : parseBankCsv(dto.content);

    if (parsed.rows.length === 0) {
      throw new BadRequestException(
        parsed.errors.length
          ? `No transactions imported. ${parsed.errors.slice(0, 5).join('; ')}`
          : 'No transactions found in file',
      );
    }

    const result = await this.reconciliationService.importTransactions(
      req.membership.organizationId,
      bankAccountId,
      parsed.rows,
      { source: dto.format },
    );

    return {
      success: true,
      data: {
        ...result,
        rejected: parsed.errors.length,
        parseErrors: parsed.errors.slice(0, 20),
        parseErrorCount: parsed.errors.length,
      },
    };
  }
}

@Controller('api/v1/bank-transactions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BankTransactionsController {
  constructor(private reconciliationService: ReconciliationService) {}

  @Get()
  @RequirePermission('bank.read')
  async list(@Req() req: any, @Query('bankAccountId') bankAccountId?: string) {
    const txns = await this.reconciliationService.listForOrg(
      req.membership.organizationId,
      bankAccountId,
    );
    return { success: true, data: txns };
  }

  @Post(':id/match-invoice')
  @RequirePermission('bank.reconcile')
  async matchInvoice(@Req() req: any, @Param('id') id: string, @Body() dto: MatchInvoiceDto) {
    const result = await this.reconciliationService.matchToInvoice(
      req.membership.organizationId,
      id,
      dto.invoiceId,
    );
    return { success: true, data: result };
  }

  @Post(':id/match-bill')
  @RequirePermission('bank.reconcile')
  async matchBill(@Req() req: any, @Param('id') id: string, @Body() dto: MatchBillDto) {
    const result = await this.reconciliationService.matchToBill(
      req.membership.organizationId,
      id,
      dto.billId,
    );
    return { success: true, data: result };
  }

  @Post(':id/categorize')
  @RequirePermission('bank.reconcile')
  async categorize(@Req() req: any, @Param('id') id: string, @Body() dto: CategorizeDto) {
    const result = await this.reconciliationService.categorize(
      req.membership.organizationId,
      id,
      dto.accountCode,
    );
    return { success: true, data: result };
  }

  @Post(':id/reconcile')
  @RequirePermission('bank.reconcile')
  async reconcile(@Req() req: any, @Param('id') id: string) {
    const result = await this.reconciliationService.reconcile(req.membership.organizationId, id);
    return { success: true, data: result };
  }

  @Post(':id/unmatch')
  @RequirePermission('bank.reconcile')
  async unmatch(@Req() req: any, @Param('id') id: string) {
    const result = await this.reconciliationService.unmatch(req.membership.organizationId, id);
    return { success: true, data: result };
  }
}
