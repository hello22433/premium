import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, FindOptionsWhere, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';
import { ExternalApiWebhookLogEntity } from '../../entity/external.api.webhook.log.entity';
import { CouponCancelWebhookSender } from './coupon.cancel.webhook.sender';
import {
  CancelWebhookLogItemDto,
  CancelWebhookLogListResDto,
  CancelWebhookLogQueryDto,
  CancelWebhookTestResDto,
  CancelWebhookViewDto,
  UpdateCancelWebhookReqDto,
} from './dto/cancel.webhook.admin.dto';

const LOG_PREVIEW_LENGTH = 500;
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^fe80:/i,
];

@Injectable()
export class CancelWebhookAdminService {
  constructor(
    @InjectRepository(ExternalApiAccountEntity)
    private readonly accountRepository: Repository<ExternalApiAccountEntity>,
    @InjectRepository(ExternalApiWebhookLogEntity)
    private readonly logRepository: Repository<ExternalApiWebhookLogEntity>,
    private readonly sender: CouponCancelWebhookSender,
  ) {}

  async get(accountId: string): Promise<CancelWebhookViewDto> {
    const account = await this.findAccount(accountId);
    return { url: account.cancelWebhookUrl, enabled: account.cancelWebhookEnabled };
  }

  async update(accountId: string, body: UpdateCancelWebhookReqDto): Promise<CancelWebhookViewDto> {
    this.validateUrl(body.url);
    if (body.enabled && !body.url) {
      throw new BadRequestException('활성화하려면 URL이 필요합니다.');
    }
    const account = await this.findAccount(accountId);
    account.cancelWebhookUrl = body.url;
    account.cancelWebhookEnabled = body.enabled;
    await this.accountRepository.save(account);
    return { url: account.cancelWebhookUrl, enabled: account.cancelWebhookEnabled };
  }

  async clear(accountId: string): Promise<void> {
    const account = await this.findAccount(accountId);
    account.cancelWebhookUrl = null;
    account.cancelWebhookEnabled = false;
    await this.accountRepository.save(account);
  }

  async test(accountId: string): Promise<CancelWebhookTestResDto> {
    const account = await this.findAccount(accountId);
    if (!account.cancelWebhookUrl) {
      throw new BadRequestException('등록된 URL이 없습니다.');
    }
    const result = await this.sender.send(account, null, {
      trId: 'TEST_TR_ID',
      couponStatus: 'CANCEL',
      cancelledAt: new Date(),
    });
    return {
      ok: result.isSuccess,
      httpStatus: result.httpStatus,
      responseTimeMs: result.responseTimeMs,
      errorMessage: result.errorMessage,
    };
  }

  async listLogs(accountId: string, query: CancelWebhookLogQueryDto): Promise<CancelWebhookLogListResDto> {
    await this.findAccount(accountId);

    const page = query.page ?? 1;
    const size = query.size ?? 50;
    const where = this.buildLogWhere(accountId, query);

    const [rows, total] = await this.logRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * size,
      take: size,
    });

    let items = rows.map((row) => this.toLogItem(row));
    if (query.trId) {
      const needle = query.trId;
      items = items.filter((item) => (item.trId ?? '').includes(needle));
    }

    return { items, total, page, size };
  }

  private async findAccount(accountId: string): Promise<ExternalApiAccountEntity> {
    const account = await this.accountRepository.findOne({ where: { id: accountId } });
    if (!account) throw new NotFoundException('외부 API 계정을 찾을 수 없습니다.');
    return account;
  }

  private validateUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('올바른 URL 형식이 아닙니다.');
    }
    if (parsed.protocol !== 'https:') {
      throw new BadRequestException('HTTPS URL만 허용됩니다.');
    }
    if (PRIVATE_HOST_PATTERNS.some((p) => p.test(parsed.hostname))) {
      throw new BadRequestException('사설망/loopback 주소는 허용되지 않습니다.');
    }
  }

  private buildLogWhere(
    accountId: string,
    query: CancelWebhookLogQueryDto,
  ): FindOptionsWhere<ExternalApiWebhookLogEntity> {
    const where: FindOptionsWhere<ExternalApiWebhookLogEntity> = { externalApiAccountId: accountId };

    if (query.result === 'success') where.isSuccess = true;
    if (query.result === 'failure') where.isSuccess = false;

    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    if (from && to) where.createdAt = Between(from, to);
    else if (from) where.createdAt = MoreThanOrEqual(from);
    else if (to) where.createdAt = LessThanOrEqual(to);

    return where;
  }

  private toLogItem(row: ExternalApiWebhookLogEntity): CancelWebhookLogItemDto {
    const body = row.requestBody ?? '';
    let trId: string | null = null;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.trId === 'string') trId = parsed.trId;
    } catch {
      // ignore
    }
    return {
      id: row.id,
      createdAt: row.createdAt,
      trId,
      eventType: row.eventType,
      eventId: row.eventId,
      isSuccess: row.isSuccess,
      httpStatus: row.responseStatus,
      responseTimeMs: row.responseTimeMs,
      errorMessage: row.errorMessage,
      requestBodyPreview: this.preview(body),
      responseBodyPreview: row.responseBody == null ? null : this.preview(row.responseBody),
    };
  }

  private preview(text: string): string {
    return text.length > LOG_PREVIEW_LENGTH ? text.slice(0, LOG_PREVIEW_LENGTH) : text;
  }
}
