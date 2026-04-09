import { HttpException } from '@nestjs/common';
import { AuthErrorDefinition } from './auth-error-code';

/**
 * 로그인/인증 API 전용 예외.
 *
 * 응답 body 형식:
 * ```json
 * { "statusCode": 400, "errorCode": "EXPIRED_VERIFY_CODE", "message": "만료된 인증 코드입니다." }
 * ```
 */
export class AuthException extends HttpException {
  readonly errorCode: string;

  constructor(error: AuthErrorDefinition) {
    super(
      {
        statusCode: error.status,
        errorCode: error.code,
        message: error.message,
      },
      error.status,
    );
    this.errorCode = error.code;
  }
}
