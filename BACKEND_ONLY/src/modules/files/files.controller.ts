/**
 * Files Controller
 * 
 * Handles file upload, retrieval, and deletion endpoints
 * 
 * Features:
 * - Multi-file upload with validation
 * - File size limit (default 20MB)
 * - MIME type validation
 * - Organizatin-based file isolation
 * - File metadata storage in database
 * - Download endpoint
 * - Delete endpoint
 * 
 * Endpoints:
 * POST   /api/v1/files/upload         - Upload files
 * GET    /api/v1/files                - List organization files
 * GET    /api/v1/files/:id/download   - Download file
 * DELETE /api/v1/files/:id            - Delete file
 */

import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  UploadedFiles,
  UseInterceptors,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
  Body,
  Query,
  Res,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as mime from 'mime-types';
import { JwtGuard } from '../auth/guards/jwt.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { FilesService } from './files.service';

// Configuration
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const MAX_FILE_SIZE = parseInt(process.env.UPLOAD_MAX_SIZE || '20971520'); // 20MB
const ALLOWED_MIME_TYPES = (
  process.env.ALLOWED_MIME_TYPES ||
  'application/pdf,image/jpeg,image/png,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv'
).split(',');

/**
 * Custom file filter for multer
 */
const fileFilter = (req: any, file: Express.Multer.File, cb: any) => {
  // Check MIME type
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(
      new BadRequestException(
        `File type ${file.mimetype} not allowed. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`,
      ),
      false,
    );
  }

  cb(null, true);
};

/**
 * Custom storage configuration for multer
 */
const storage = diskStorage({
  destination: (req: any, file: Express.Multer.File, cb: any) => {
    const organizationId = req.body.organizationId || req.user?.organizationId;

    if (!organizationId) {
      return cb(new UnauthorizedException('Organization ID required'));
    }

    const uploadPath = path.join(UPLOAD_DIR, organizationId);

    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }

    cb(null, uploadPath);
  },
  filename: (req: any, file: Express.Multer.File, cb: any) => {
    // Generate unique filename: timestamp-random-originalname
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    const filename = `${timestamp}-${random}${ext}`;

    cb(null, filename);
  },
});

/**
 * Upload DTO
 */
export class UploadFilesDto {
  organizationId: string;
}

/**
 * Files Controller
 */
@Controller('/api/v1/files')
@UseGuards(JwtGuard)
export class FilesController {
  constructor(private readonly filesService: FilesService) {
    // Ensure upload directory exists
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
  }

  /**
   * Upload files endpoint
   * 
   * POST /api/v1/files/upload
   * 
   * Form Data:
   * - files: File[] (required)
   * - organizationId: string (required)
   */
  @Post('/upload')
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      // Max 10 files per request
      storage,
      fileFilter,
      limits: {
        fileSize: MAX_FILE_SIZE,
      },
    }),
  )
  async uploadFiles(
    @UploadedFiles() files: Express.Multer.File[],
    @Body() dto: UploadFilesDto,
    @CurrentUser() user: User,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files provided');
    }

    // Verify organization access
    if (dto.organizationId !== user.organizationId && !user.isAdmin) {
      throw new UnauthorizedException('Cannot upload to other organizations');
    }

    const uploadedFiles = [];

    for (const file of files) {
      try {
        // Create file record in database
        const fileRecord = await this.filesService.createFileRecord({
          filename: file.filename,
          originalName: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          path: file.path,
          organizationId: dto.organizationId,
          uploadedBy: user.id,
        });

        uploadedFiles.push({
          id: fileRecord.id,
          name: fileRecord.originalName,
          size: fileRecord.size,
          mimeType: fileRecord.mimetype,
          uploadedAt: fileRecord.createdAt,
          url: `/api/v1/files/${fileRecord.id}/download`,
        });
      } catch (error) {
        console.error(`Failed to create file record for ${file.originalname}:`, error);
        throw new BadRequestException(`Failed to process file: ${file.originalname}`);
      }
    }

    return {
      success: true,
      count: uploadedFiles.length,
      files: uploadedFiles,
    };
  }

  /**
   * List files endpoint
   * 
   * GET /api/v1/files?organizationId=org-123&limit=10&page=1
   */
  @Get()
  async listFiles(
    @Query('organizationId') organizationId: string,
    @Query('limit') limit: string = '10',
    @Query('page') page: string = '1',
    @CurrentUser() user: User,
  ) {
    // Default to current user's organization
    const org = organizationId || user.organizationId;

    // Verify access
    if (org !== user.organizationId && !user.isAdmin) {
      throw new UnauthorizedException('Cannot access other organizations files');
    }

    const files = await this.filesService.getOrganizationFiles(org, {
      limit: parseInt(limit),
      page: parseInt(page),
    });

    return {
      success: true,
      total: files.total,
      page: parseInt(page),
      limit: parseInt(limit),
      files: files.data.map((file) => ({
        id: file.id,
        name: file.originalName,
        size: file.size,
        mimeType: file.mimetype,
        uploadedAt: file.createdAt,
        uploadedBy: file.uploadedBy,
        url: `/api/v1/files/${file.id}/download`,
      })),
    };
  }

  /**
   * Download file endpoint
   * 
   * GET /api/v1/files/:id/download
   */
  @Get(':id/download')
  async downloadFile(@Param('id') fileId: string, @CurrentUser() user: User, @Res() res: Response) {
    try {
      // Get file record
      const fileRecord = await this.filesService.getFileById(fileId);

      if (!fileRecord) {
        throw new NotFoundException('File not found');
      }

      // Verify access
      if (fileRecord.organizationId !== user.organizationId && !user.isAdmin) {
        throw new UnauthorizedException('Cannot download from other organizations');
      }

      // Check file exists
      if (!fs.existsSync(fileRecord.path)) {
        throw new NotFoundException('File not found on disk');
      }

      // Set response headers
      res.setHeader('Content-Type', fileRecord.mimetype);
      res.setHeader('Content-Disposition', `attachment; filename="${fileRecord.originalName}"`);
      res.setHeader('Content-Length', fileRecord.size);

      // Stream file
      const fileStream = fs.createReadStream(fileRecord.path);
      fileStream.pipe(res);

      // Log download
      await this.filesService.logFileAccess(fileId, 'download', user.id);
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof UnauthorizedException) {
        throw error;
      }
      console.error('File download error:', error);
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: 'Failed to download file',
      });
    }
  }

  /**
   * Delete file endpoint
   * 
   * DELETE /api/v1/files/:id
   */
  @Delete(':id')
  async deleteFile(@Param('id') fileId: string, @CurrentUser() user: User) {
    // Get file record
    const fileRecord = await this.filesService.getFileById(fileId);

    if (!fileRecord) {
      throw new NotFoundException('File not found');
    }

    // Verify access (only owner or admin can delete)
    if (fileRecord.uploadedBy !== user.id && !user.isAdmin) {
      throw new UnauthorizedException('Cannot delete files uploaded by others');
    }

    // Verify organization
    if (fileRecord.organizationId !== user.organizationId && !user.isAdmin) {
      throw new UnauthorizedException('Cannot delete from other organizations');
    }

    // Delete physical file
    try {
      if (fs.existsSync(fileRecord.path)) {
        fs.unlinkSync(fileRecord.path);
      }
    } catch (error) {
      console.error('Failed to delete physical file:', error);
    }

    // Delete database record
    await this.filesService.deleteFileRecord(fileId);

    return {
      success: true,
      message: 'File deleted successfully',
    };
  }

  /**
   * Get file info endpoint
   * 
   * GET /api/v1/files/:id
   */
  @Get(':id')
  async getFileInfo(@Param('id') fileId: string, @CurrentUser() user: User) {
    const fileRecord = await this.filesService.getFileById(fileId);

    if (!fileRecord) {
      throw new NotFoundException('File not found');
    }

    // Verify access
    if (fileRecord.organizationId !== user.organizationId && !user.isAdmin) {
      throw new UnauthorizedException('Cannot access files from other organizations');
    }

    return {
      success: true,
      file: {
        id: fileRecord.id,
        name: fileRecord.originalName,
        size: fileRecord.size,
        mimeType: fileRecord.mimetype,
        uploadedAt: fileRecord.createdAt,
        uploadedBy: fileRecord.uploadedBy,
        downloadUrl: `/api/v1/files/${fileRecord.id}/download`,
      },
    };
  }
}

/**
 * Files Module Setup (for app.module.ts)
 * 
 * Import and add to modules:
 * 
 * @Module({
 *   imports: [
 *     // ... other imports
 *     MulterModule.register({
 *       dest: UPLOAD_DIR,
 *     }),
 *   ],
 *   controllers: [FilesController],
 *   providers: [FilesService],
 *   exports: [FilesService],
 * })
 * export class FilesModule {}
 */

/**
 * Don't forget to install dependencies:
 * npm install @nestjs/platform-express multer mime-types
 * npm install --save-dev @types/multer @types/mime-types
 */
