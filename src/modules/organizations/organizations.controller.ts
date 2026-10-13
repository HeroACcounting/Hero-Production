import { Body, Controller, Delete, Get, Patch, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { IsString, IsOptional, IsIn, IsNumber } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MembershipService } from '../tenancy/membership.service';
import { ChartOfAccountsService } from '../ledger/chart-of-accounts.service';
import { getPool, withRlsBypass } from '../../db/pool';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';

class CreateOrganizationDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  countryCode?: string;

  @IsOptional()
  @IsIn(['trial', 'monthly'])
  plan?: 'trial' | 'monthly';

  @IsOptional()
  @IsString()
  baseCurrency?: string;

  @IsOptional()
  @IsNumber()
  taxStandardRate?: number;

  @IsOptional()
  @IsNumber()
  taxFreeRate?: number;

  @IsOptional()
  @IsNumber()
  taxInputRate?: number;
}

@Controller('api/v1/organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(
    private membershipService: MembershipService,
    private chartOfAccountsService: ChartOfAccountsService,
  ) {}

  @Post()
  async create(@Req() req: any, @Body() dto: CreateOrganizationDto) {
    const { organizationId } = await this.membershipService.createOrganizationWithOwner(
      req.userId,
      dto.name,
      dto.countryCode ?? 'AU',
      dto.plan ?? 'trial',
      dto.baseCurrency,
      dto.taxStandardRate,
      dto.taxFreeRate,
      dto.taxInputRate,
    );
    // Every new org gets a standard chart of accounts immediately — you
    // can't post an invoice without accounts to post it against.
    // Wrap in withRlsBypass because the user might not have the org set in their context yet
    await withRlsBypass(async () => {
      await this.chartOfAccountsService.bootstrapStandardAccounts(organizationId);
    });
    return { success: true, data: { organizationId, trialDays: dto.plan === 'trial' ? 3 : 0, plan: dto.plan ?? 'trial' } };
  }

  @Patch('current')
  @UseGuards(PermissionsGuard)
  @RequirePermission('org.manage')
  async updateCurrent(@Req() req: any, @Body() dto: CreateOrganizationDto) {
    const countryCode = String(dto.countryCode || '').trim().toUpperCase();
    if (!countryCode) throw new BadRequestException('Country is required');
    const pool = getPool();
    const result = await pool.query(
      `UPDATE organizations SET
         name = COALESCE(NULLIF($1, ''), name),
         country_code = $2,
         base_currency = COALESCE(NULLIF($4, ''), base_currency),
         tax_standard_rate = $5,
         tax_free_rate = $6,
         tax_input_rate = $7,
         updated_at = now()
       WHERE id = $3 AND is_active = TRUE
       RETURNING id, name, country_code, base_currency, tax_standard_rate, tax_free_rate, tax_input_rate`,
      [dto.name?.trim() || '', countryCode, req.membership.organizationId, dto.baseCurrency?.trim()?.toUpperCase() || null, dto.taxStandardRate ?? null, dto.taxFreeRate ?? null, dto.taxInputRate ?? null],
    );
    if (!result.rows.length) throw new BadRequestException('Organization not found');
    return { success: true, data: result.rows[0] };
  }

  @Get('mine')
  async listMine(@Req() req: any) {
    const pool = getPool();
    // Prefer logo flag when migration 0014 has been applied; fall back if not.
    try {
      const result = await pool.query(
        `SELECT o.id, o.name, o.country_code, r.name AS role_name,
                (o.logo_storage_key IS NOT NULL) AS has_logo
         FROM memberships m
         JOIN organizations o ON o.id = m.organization_id
         JOIN roles r ON r.id = m.role_id
         WHERE m.user_id = $1 AND m.is_active = TRUE AND o.is_active = TRUE
         ORDER BY o.created_at ASC`,
        [req.userId],
      );
      return { success: true, data: result.rows };
    } catch {
      const result = await pool.query(
        `SELECT o.id, o.name, o.country_code, r.name AS role_name,
                FALSE AS has_logo
         FROM memberships m
         JOIN organizations o ON o.id = m.organization_id
         JOIN roles r ON r.id = m.role_id
         WHERE m.user_id = $1 AND m.is_active = TRUE AND o.is_active = TRUE
         ORDER BY o.created_at ASC`,
        [req.userId],
      );
      return { success: true, data: result.rows };
    }
  }

  private logoRoot() {
    return path.resolve(process.env.DOCUMENT_STORAGE_DIR || path.join(process.cwd(), 'storage', 'documents'), 'logos');
  }

  @Post('current/logo')
  @UseGuards(PermissionsGuard)
  @RequirePermission('org.manage')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } }))
  async uploadLogo(
    @Req() req: any,
    @UploadedFile() file?: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ) {
    if (!file) throw new BadRequestException('Choose a logo image to upload.');
    const allowedMime = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowedExt = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
    if (!allowedMime.has(file.mimetype) || !allowedExt.has(ext)) {
      throw new BadRequestException('Logo must be PNG, JPG, WEBP or GIF (max 2 MB).');
    }
    if (file.size > 2 * 1024 * 1024) {
      throw new BadRequestException('Logo must be 2 MB or smaller.');
    }

    const orgId = req.membership.organizationId as string;
    const root = this.logoRoot();
    await fs.mkdir(root, { recursive: true });

    // Remove previous logo file if present
    const pool = getPool();
    const prev = await pool.query(
      `SELECT logo_storage_key FROM organizations WHERE id = $1`,
      [orgId],
    );
    const prevKey = prev.rows[0]?.logo_storage_key as string | undefined;
    if (prevKey) {
      try {
        await fs.unlink(path.join(root, path.basename(prevKey)));
      } catch {
        /* ignore missing */
      }
    }

    const key = `${orgId}-${randomUUID()}${ext}`;
    await fs.writeFile(path.join(root, key), file.buffer);
    await pool.query(
      `UPDATE organizations
       SET logo_storage_key = $1, logo_mime_type = $2, logo_updated_at = now(), updated_at = now()
       WHERE id = $3`,
      [key, file.mimetype, orgId],
    );
    return { success: true, data: { has_logo: true } };
  }

  @Get('current/logo')
  @UseGuards(PermissionsGuard)
  async getLogo(@Req() req: any, @Res() res: Response) {
    const orgId = req.membership.organizationId as string;
    const pool = getPool();
    const result = await pool.query(
      `SELECT logo_storage_key, logo_mime_type FROM organizations WHERE id = $1 AND is_active = TRUE`,
      [orgId],
    );
    const row = result.rows[0];
    if (!row?.logo_storage_key) {
      throw new BadRequestException('No logo uploaded for this organization.');
    }
    const filePath = path.join(this.logoRoot(), path.basename(row.logo_storage_key));
    try {
      const buf = await fs.readFile(filePath);
      res.setHeader('Content-Type', row.logo_mime_type || 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(buf);
    } catch {
      throw new BadRequestException('Logo file is missing from storage.');
    }
  }

  @Delete('current/logo')
  @UseGuards(PermissionsGuard)
  @RequirePermission('org.manage')
  async deleteLogo(@Req() req: any) {
    const orgId = req.membership.organizationId as string;
    const pool = getPool();
    const prev = await pool.query(
      `SELECT logo_storage_key FROM organizations WHERE id = $1`,
      [orgId],
    );
    const prevKey = prev.rows[0]?.logo_storage_key as string | undefined;
    if (prevKey) {
      try {
        await fs.unlink(path.join(this.logoRoot(), path.basename(prevKey)));
      } catch {
        /* ignore */
      }
    }
    await pool.query(
      `UPDATE organizations
       SET logo_storage_key = NULL, logo_mime_type = NULL, logo_updated_at = NULL, updated_at = now()
       WHERE id = $1`,
      [orgId],
    );
    return { success: true, data: { has_logo: false } };
  }
}