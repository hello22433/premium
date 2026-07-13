import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Response } from 'express';

export class ExternalApiException extends Error {
  constructor(
    public readonly code: string,
    public readonly errorMessage: string,
    public readonly detail?: string,
  ) {
    super(errorMessage);
  }
}

@Catch()
export class ExternalApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExternalApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    this.logger.warn(
      `[DEBUG] filter ENTER type=${(exception as any)?.constructor?.name} ` +
        `code=${(exception as any)?.code} ` +
        `msg=${(exception as any)?.errorMessage ?? (exception as any)?.message} ` +
        `headersSent=${response.headersSent}`,
    );

    let httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = '9999';
    let message = '시스템 오류';
    let detail: string | undefined;

    if (exception instanceof ExternalApiException) {
      code = exception.code;
      message = exception.errorMessage;
      detail = exception.detail;

      // Map codes to HTTP status
      const codeStatusMap: Record<string, number> = {
        '1001': HttpStatus.UNAUTHORIZED,
        '1002': HttpStatus.FORBIDDEN,
        '1004': HttpStatus.FORBIDDEN,
        '1005': HttpStatus.FORBIDDEN,
        '2001': HttpStatus.BAD_REQUEST,
        '2002': HttpStatus.BAD_REQUEST,
        '2004': HttpStatus.UNPROCESSABLE_ENTITY,
        '2005': HttpStatus.CONFLICT,
        '3001': HttpStatus.NOT_FOUND,
        '3002': HttpStatus.PAYMENT_REQUIRED,
        '3003': HttpStatus.INTERNAL_SERVER_ERROR,
        '3004': HttpStatus.INTERNAL_SERVER_ERROR,
        '3005': HttpStatus.CONFLICT,
        '3006': HttpStatus.CONFLICT,
        '3007': HttpStatus.CONFLICT,
        '3008': HttpStatus.CONFLICT,
        '3009': HttpStatus.CONFLICT,
        '3010': HttpStatus.CONFLICT,
        '4001': HttpStatus.NOT_FOUND,
        '4002': HttpStatus.NOT_FOUND,
        '4003': HttpStatus.NOT_FOUND,
      };
      httpStatus = codeStatusMap[code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
    } else if (exception instanceof ThrottlerException) {
      httpStatus = HttpStatus.TOO_MANY_REQUESTS;
      code = '1003';
      message = '요청 횟수 초과';
    } else if (exception instanceof HttpException) {
      httpStatus = exception.getStatus();
      if (httpStatus === HttpStatus.UNAUTHORIZED) {
        code = '1001';
        message = '인증 실패';
      } else if (httpStatus === HttpStatus.BAD_REQUEST) {
        code = '2001';
        const exResponse = exception.getResponse();
        message = typeof exResponse === 'string' ? exResponse : '잘못된 요청';
        if (typeof exResponse === 'object' && (exResponse as any).message) {
          detail = Array.isArray((exResponse as any).message)
            ? (exResponse as any).message.join(', ')
            : (exResponse as any).message;
        }
      }
    } else if (exception instanceof Error) {
      this.logger.error(`Unhandled error: ${exception.message}`, exception.stack);
    }

    response.status(httpStatus).json({
      result: { code, message, ...(detail ? { detail } : {}) },
    });
  }
}
