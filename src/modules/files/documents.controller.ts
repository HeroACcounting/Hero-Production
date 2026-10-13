import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { DocumentsService, StoredUpload } from './documents.service';

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/x-ofx',
  'application/vnd.intu.qfx',
  'application/ofx',
]);
const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx',
  '.xls', '.xlsx', '.csv',
  '.txt',
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.ofx', '.qfx',
]);

@Controller('api/v1/documents')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE } }))
  @RequirePermission('file_ops.manage')
  async upload(
    @Req() req: { userId: string; membership: { organizationId: string } },
    @UploadedFile() file: StoredUpload | undefined,
    @Body() body: { entityType?: string },
  ) {
    if (!file) throw new BadRequestException('Choose a document to upload.');
    const extension = file.originalname.slice(file.originalname.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension) || !ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException('Supported files: PDF, DOC, DOCX, XLS, XLSX, CSV, TXT, PNG, JPG, WEBP, GIF, OFX, QFX (max 20 MB).');
    }
    if (file.size > MAX_FILE_SIZE) throw new BadRequestException('Maximum document size is 20 MB.');
    const entityType = body.entityType || 'DOCUMENT';
    if (!['DOCUMENT', 'INVOICE', 'BILL', 'RECEIPT', 'EXPENSE', 'OTHER'].includes(entityType)) {
      throw new BadRequestException('Invalid document category.');
    }
    return { success: true, data: await this.documentsService.upload(req.membership.organizationId, req.userId, file, entityType) };
  }

  @Get()
  @RequirePermission('file_ops.read')
  async list(@Req() req: { membership: { organizationId: string } }) {
    return { success: true, data: await this.documentsService.list(req.membership.organizationId) };
  }

  @Get(':id/download')
  @RequirePermission('file_ops.read')
  async download(
    @Req() req: { membership: { organizationId: string } },
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const document = await this.documentsService.readDownload(req.membership.organizationId, id);
    res.setHeader('Content-Type', document.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${String(document.name).replace(/"/g, '')}"`);
    res.send(document.fileBuffer);
  }

  @Delete(':id')
  @RequirePermission('file_ops.manage')
  async remove(@Req() req: { membership: { organizationId: string } }, @Param('id') id: string) {
    return { success: true, data: await this.documentsService.remove(req.membership.organizationId, id) };
  }
}
