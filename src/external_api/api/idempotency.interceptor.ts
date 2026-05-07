import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Observable, defer, of, throwError } from 'rxjs';
import { catchError, concatMap } from 'rxjs/operators';
import { createHash } from 'crypto';
import { Request, Response } from 'express';

import { IdempotencyKeyEntity, IdempotencyKeyStatus } from '../../entity/idempotency.key.entity';
import { ExternalApiException } from './external.api.exception.filter';

const IDEMPOTENCY_KEY_TTL_HOURS = 24;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger('IdempotencyInterceptor');

  constructor(
    @InjectRepository(IdempotencyKeyEntity)
    private idempotencyKeyRepository: Repository<IdempotencyKeyEntity>,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const idempotencyKey = request.headers['idempotency-key'] as string;
    if (!idempotencyKey) {
      throw new ExternalApiException('2001', '잘못된 요청', 'Idempotency-Key 헤더가 필요합니다');
    }
    if (idempotencyKey.length > 64) {
      throw new ExternalApiException('2001', '잘못된 요청', 'Idempotency-Key는 최대 64자입니다');
    }

    const userId = (request as any).apiAccount?.user?.id;
    const endpoint = `${request.method} ${request.route?.path || request.path}`;
    const requestHash = createHash('sha256').update(JSON.stringify(request.body)).digest('hex');

    const existing = await this.idempotencyKeyRepository.findOne({
      where: { idempotencyKey, userId, endpoint },
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ExternalApiException('2004', '멱등키 요청 불일치');
      }
      if (existing.status === IdempotencyKeyStatus.PROCESSING) {
        throw new ExternalApiException('2005', '요청 처리 중');
      }

      const isExpired = existing.expiresAt && new Date() > existing.expiresAt;
      if (isExpired) {
        await this.idempotencyKeyRepository.remove(existing);
      } else {
        if (existing.responseStatus) {
          response.status(existing.responseStatus);
        }
        return of(existing.responseBody);
      }
    }

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + IDEMPOTENCY_KEY_TTL_HOURS * 60 * 60 * 1000);

    const newKey = this.idempotencyKeyRepository.create({
      idempotencyKey,
      userId,
      endpoint,
      requestHash,
      status: IdempotencyKeyStatus.PROCESSING,
      createdAt,
      expiresAt,
    });

    try {
      await this.idempotencyKeyRepository.save(newKey);
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') {
        // unique 제약 위반 → 동시 요청
        throw new ExternalApiException('2005', '요청 처리 중');
      }
      throw error;
    }

    // selector를 async 로 두면 Promise<Observable>이 next emission으로 흘러나와
    // ExceptionFilter가 우회되고 빈 본문 + HTTP 200으로 응답된다.
    // 동기 selector + defer로 비동기 작업을 감싸 emission 순서와 예외 전파를 보장한다.
    return next.handle().pipe(
      concatMap((responseBody) =>
        defer(async () => {
          try {
            newKey.status = IdempotencyKeyStatus.COMPLETE;
            newKey.responseBody = responseBody;
            newKey.responseStatus = response.statusCode;
            await this.idempotencyKeyRepository.save(newKey);
          } catch (err) {
            this.logger.warn(`멱등키 응답 캐싱 실패 - key: ${idempotencyKey}`, err);
          }
          return responseBody;
        }),
      ),
      catchError((err) => {
        this.logger.warn(
          `[DEBUG] interceptor catchError ENTER type=${err?.constructor?.name} ` +
            `code=${err?.code} msg=${err?.errorMessage ?? err?.message}`,
        );
        return defer(async () => {
          this.logger.warn('[DEBUG] interceptor cleanup defer running');
          try {
            await this.idempotencyKeyRepository.remove(newKey);
          } catch (removeErr) {
            this.logger.warn(`멱등키 제거 실패 - key: ${idempotencyKey}`, removeErr);
          }
        }).pipe(
          concatMap(() => {
            this.logger.warn('[DEBUG] interceptor re-throwing');
            return throwError(() => err);
          }),
        );
      }),
    );
  }
}
