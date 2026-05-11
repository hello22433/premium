import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';

import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';
import { ExternalApiWebhookLogEntity } from '../../entity/external.api.webhook.log.entity';

export const EVENT_TYPE_COUPON_CANCEL = 'COUPON_CANCEL';

const HTTP_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BODY_BYTES = 2 * 1024;

export interface CouponCancelWebhookOutbound {
  trId: string;
  couponStatus: string;
  cancelledAt: Date;
}

export interface CouponCancelWebhookResult {
  isSuccess: boolean;
  httpStatus: number | null;
  responseTimeMs: number;
  errorMessage: string | null;
  eventId: string;
}

@Injectable()
export class CouponCancelWebhookSender {
  private readonly logger = new Logger(CouponCancelWebhookSender.name);

  constructor(
    @InjectRepository(ExternalApiWebhookLogEntity)
    private readonly logRepository: Repository<ExternalApiWebhookLogEntity>,
    private readonly httpService: HttpService,
  ) {}

  async send(
    account: ExternalApiAccountEntity,
    orderDeliveryId: number | null,
    outbound: CouponCancelWebhookOutbound,
  ): Promise<CouponCancelWebhookResult> {
    const eventId = randomUUID();
    const url = account.cancelWebhookUrl!;
    const payload = {
      eventType: EVENT_TYPE_COUPON_CANCEL,
      eventId,
      trId: outbound.trId,
      couponStatus: outbound.couponStatus,
      cancelledAt: outbound.cancelledAt.toISOString(),
    };
    const requestBody = JSON.stringify(payload);
    const startedAt = Date.now();

    let responseStatus: number | null = null;
    let responseBody: string | null = null;
    let errorMessage: string | null = null;
    let isSuccess: boolean;

    try {
      const response = await firstValueFrom(
        this.httpService.post(url, payload, {
          timeout: HTTP_TIMEOUT_MS,
          validateStatus: () => true,
        }),
      );
      responseStatus = response.status;
      responseBody = this.truncate(this.stringifyData(response.data));
      isSuccess = response.status >= 200 && response.status < 300;
    } catch (err) {
      errorMessage = (err as AxiosError)?.message ?? String(err);
      isSuccess = false;
    }

    const responseTimeMs = Date.now() - startedAt;

    try {
      await this.logRepository.save(
        this.logRepository.create({
          externalApiAccountId: account.id,
          orderDeliveryId,
          eventType: payload.eventType,
          eventId,
          requestUrl: url,
          requestBody,
          responseStatus,
          responseBody,
          errorMessage,
          isSuccess,
          responseTimeMs,
        }),
      );
    } catch (err) {
      this.logger.error(`webhook log save failed (eventId=${eventId})`, err);
    }

    return { isSuccess, httpStatus: responseStatus, responseTimeMs, errorMessage, eventId };
  }

  private stringifyData(data: unknown): string {
    if (data == null) return '';
    if (typeof data === 'string') return data;
    try {
      return JSON.stringify(data);
    } catch {
      return String(data);
    }
  }

  private truncate(text: string): string {
    if (Buffer.byteLength(text, 'utf8') <= MAX_RESPONSE_BODY_BYTES) return text;
    const buf = Buffer.from(text, 'utf8').subarray(0, MAX_RESPONSE_BODY_BYTES);
    return buf.toString('utf8');
  }
}
