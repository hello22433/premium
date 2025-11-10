import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  private logger = new Logger('HTTP', { timestamp: true });

  private blacklist: string[] = [];

  // 민감한 정보 필드 목록 (비밀번호 등)
  private sensitiveFields: string[] = ['password', 'newPassword', 'oldPassword', 'confirmPassword'];

  private except(originalUrl: string) {
    return this.blacklist.includes(originalUrl);
    // return false 개발시 전체 로그 보기
  }

  /**
   * body에서 민감한 정보를 제거하고 입력 여부만 기록
   */
  private removeSensitiveData(body: any): any {
    if (!body || typeof body !== 'object') {
      return body;
    }

    const sanitizedBody = { ...body };

    for (const field of this.sensitiveFields) {
      if (sanitizedBody[field] !== undefined) {
        // 비밀번호 값을 제거하고 입력 여부만 기록
        const hasField = `has${field.charAt(0).toUpperCase() + field.slice(1)}`;
        sanitizedBody[hasField] = true;
        delete sanitizedBody[field];
      }
    }

    return sanitizedBody;
  }

  use(req: Request, res: Response, next: NextFunction) {
    const { ip, method, originalUrl, body } = req;
    const userAgent = req.get('user-agent') || '';
    const now = Date.now();

    res.on('finish', () => {
      const {
        statusCode,
        locals: { errorCode },
      } = res;

      const newBody = this.except(originalUrl) ? {} : this.removeSensitiveData(body);

      let message = `${method} ${originalUrl} ${ip} ${userAgent} ${statusCode} ${JSON.stringify(newBody)} ${Date.now() - now}ms`;
      message = errorCode ? message + ` ${errorCode}` : message;

      this.logger.log(message);
    });
    next();
  }
}
