import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Observable, of, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
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

    const userId = (request as any).apiUser?.id;
    const endpoint = `${request.method} ${request.route?.path || request.path}`;
    const requestHash = createHash('sha256').update(JSON.stringify(request.body)).digest('hex');

    // 기존 키 조회
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

      // 만료 체크
      if (existing.expiresAt && new Date() > existing.expiresAt) {
        await this.idempotencyKeyRepository.remove(existing);
      } else {
        // 캐싱된 응답 반환
        if (existing.responseStatus) {
          response.status(existing.responseStatus);
        }
        return of(existing.responseBody);
      }
    }

    // 새 키 등록 (PROCESSING 상태)
    const now = new Date();
    const expiresAt = new Date(now.getTime() + IDEMPOTENCY_KEY_TTL_HOURS * 60 * 60 * 1000);

    const newKey = this.idempotencyKeyRepository.create({
      idempotencyKey,
      userId,
      endpoint,
      requestHash,
      status: IdempotencyKeyStatus.PROCESSING,
      createdAt: now,
      expiresAt,
    });

    try {
      await this.idempotencyKeyRepository.save(newKey);
    } catch (error) {
      // unique 제약 위반 → 동시 요청
      if (error?.code === 'ER_DUP_ENTRY') {
        throw new ExternalApiException('2005', '요청 처리 중');
      }
      throw error;
    }

    return next.handle().pipe(
      tap(async (responseBody) => {
        try {
          newKey.status = IdempotencyKeyStatus.COMPLETE;
          newKey.responseBody = responseBody;
          newKey.responseStatus = response.statusCode;
          await this.idempotencyKeyRepository.save(newKey);
        } catch (err) {
          this.logger.warn(`멱등키 응답 캐싱 실패 - key: ${idempotencyKey}`, err);
        }
      }),
      catchError(async (err) => {
        // 핸들러 실패 시 PROCESSING 키 제거 → 클라이언트가 재시도 가능
        try {
          await this.idempotencyKeyRepository.remove(newKey);
        } catch (removeErr) {
          this.logger.warn(`멱등키 제거 실패 - key: ${idempotencyKey}`, removeErr);
        }
        return throwError(() => err);
      }),
    );
  }
}
