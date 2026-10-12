import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Never let a raw error/stack trace reach the client. Nest HttpExceptions
 * (BadRequest, Unauthorized, Forbidden, NotFound, Conflict...) map to a
 * consistent { success:false, error:{code,message} } shape; anything else
 * (a genuine bug) becomes a generic 500 with full details only in the
 * server log, per the brief's error-handling section.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // Multer file-size limit → HTTP 413 Payload Too Large
    const errName = exception && typeof exception === 'object' && 'name' in exception
      ? String((exception as any).name)
      : '';
    const errCode = exception && typeof exception === 'object' && 'code' in exception
      ? String((exception as any).code)
      : '';
    if (errName === 'MulterError' || errCode === 'LIMIT_FILE_SIZE') {
      response.status(413).json({
        success: false,
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'File exceeds the 20 MB upload limit.',
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : (body as any).message || exception.message;
      response.status(status).json({
        success: false,
        error: {
          code: HttpStatus[status] || 'ERROR',
          message: Array.isArray(message) ? message.join('; ') : message,
        },
      });
      return;
    }

    this.logger.error(
      exception instanceof Error ? exception.stack : String(exception),
    );
    const safeMessage =
      exception instanceof Error && exception.message
        ? exception.message
        : 'The server could not complete this request. Please try again.';
    response.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: safeMessage.includes('ECONN') || safeMessage.toLowerCase().includes('timeout')
          ? 'The service is temporarily unavailable. Please retry in a few seconds.'
          : 'The server could not complete this request. Please retry. If it continues, contact support with the time of the request.',
      },
    });
  }
}
