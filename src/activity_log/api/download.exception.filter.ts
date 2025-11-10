import { ExceptionFilter, Catch, ArgumentsHost, HttpException, Injectable, Inject } from '@nestjs/common';
import { Request, Response } from 'express';
import { ActivityLogService } from '../application/activity.log.service';
import { ActivityLogResult } from '../interface/activity.log.result';
import { ILoginUserInfo } from '../../auth/interface/login.user';

// Express Request 타입 확장
interface RequestWithUser extends Request {
  user?: ILoginUserInfo;
}

/**
 * 다운로드 관련 예외 필터
 * 다운로드 실패 시 로그를 자동으로 저장합니다.
 */
@Injectable()
@Catch(HttpException)
export class DownloadExceptionFilter implements ExceptionFilter {
  constructor(
    @Inject(ActivityLogService)
    private readonly activityLogService: ActivityLogService,
  ) {}

  async catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithUser>();
    const status = exception.getStatus();

    // request에서 user 정보 가져오기
    const user = request.user;
    const body = request.body as any;

    // 다운로드 관련 엔드포인트인지 확인
    if (request.url.includes('excel-download') && user) {
      try {
        // 에러 메시지 추출 (validation 에러의 구체적인 message 배열)
        const exceptionResponse = exception.getResponse();
        let errorMessage = exception.message;

        if (typeof exceptionResponse === 'object' && 'message' in exceptionResponse) {
          const responseMessage = (exceptionResponse as any).message;
          // validation 에러인 경우 배열을 문자열로 변환
          if (Array.isArray(responseMessage)) {
            errorMessage = responseMessage.join(', ');
          } else if (typeof responseMessage === 'string') {
            errorMessage = responseMessage;
          }
        }

        // 실패 로그 저장
        await this.activityLogService.createLog({
          userId: user.id,
          userEmail: user.email,
          method: request.method,
          requestUrl: request.url,
          actionType: 'EXCEL_DOWNLOAD',
          ipAddress: request.ip || '',
          userAgent: request.get('user-agent'),
          statusCode: status,
          result: ActivityLogResult.FAILURE,
          responseTime: 0, // 실패한 경우 측정 불가
          downloadReason: body?.downloadReason,
          recordCount: undefined,
          requestParams: this.extractParams(body),
          errorMessage: errorMessage,
        });
      } catch (logError) {
        // 로그 저장 실패해도 원래 에러는 던져야 함
        console.error('Failed to save download failure log:', logError);
      }
    }

    // 원래 예외 응답 반환 (validation 에러 포함)
    const exceptionResponse = exception.getResponse();

    // getResponse()가 객체인 경우 그대로 반환, 아니면 message 사용
    if (typeof exceptionResponse === 'object') {
      response.status(status).json(exceptionResponse);
    } else {
      response.status(status).json({
        statusCode: status,
        timestamp: new Date().toISOString(),
        path: request.url,
        message: exceptionResponse,
      });
    }
  }

  /**
   * body에서 파라미터 추출 (password, downloadReason 제외)
   */
  private extractParams(body: any): any {
    if (!body) return {};

    const { password, downloadReason, ...params } = body;
    return params;
  }
}
