import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { format } from 'date-fns';
import { ConfigService } from '@nestjs/config';
import { GalaxiaPushRawTransaction, IGalaxia } from '../interface/galaxia';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { IGsmbiz } from '../interface/gsmbiz';
import { IGiftiel } from '../interface/giftiel';
import { IGiftiShow } from '../interface/giftishow';
import { ICulture } from '../interface/culture';
import { ISsgIssue } from '../interface/ssg.issue';
import { IDaou } from '../interface/daou';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { Brackets, In, Repository } from 'typeorm';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { parseDateString, isExpiredYMD, formatDateYMD } from '../../util/date.util';
import {
  PartnerCompanyType,
  ApiCallResult,
  BatchStatistics,
  PartnerCompanyGroup,
  VerifyItem,
  VerifyResult,
} from './partner.company.extern.batch.types';
import { GalaxiaBarcodeLogEntity } from '../../entity/galaxia.barcode.log.entity';

// ===== 상수 정의 =====
const PARTNER_COMPANY_TYPES = {
  GALAXIA: 'GALAXIA',
  GS_M_BIZ: 'GS_M_BIZ',
  GIFTIEL: 'GIFTIEL',
  GIFT_SHOW: 'GIFT_SHOW',
  CULTURELAND: 'CULTURELAND',
  SSG: 'SSG',
  DAOU: 'DAOU',
} as const;

const DELIVERY_STATUS_PATTERN = 'COMPLETE%';

@Injectable()
export class PartnerCompanyExternBatchService {
  constructor(
    @Inject('IGalaxia')
    private galaxia: IGalaxia,
    @Inject('IGsmbiz')
    private gsmbiz: IGsmbiz,
    @Inject('IGiftiel')
    private giftiel: IGiftiel,
    @Inject('IGiftiShow')
    private giftiShow: IGiftiShow,
    @Inject('ICulture')
    private culture: ICulture,
    @Inject('ISsgIssue')
    private ssgIssue: ISsgIssue,
    @Inject('IDaou')
    private daou: IDaou,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(GalaxiaBarcodeLogEntity)
    private galaxiaBarcodeLogRepository: Repository<GalaxiaBarcodeLogEntity>,
    private configService: ConfigService,
    private cryptoCipher: CryptoCipher,
  ) {
    this.galaxiaEncKey = this.configService.getOrThrow('GALAXIA_ENCKEY');
    this.galaxiaEncIv = this.configService.getOrThrow('GALAXIA_ENCIV');
  }

  private logger = new Logger('PARTNER_COMPANY_EXTERN_BATCH');

  private readonly galaxiaEncKey: string;
  private readonly galaxiaEncIv: string;
  private readonly galaxiaEncAlgorithm = 'aes-128-cbc';

  // ===== 설정값 =====
  private get pageSize(): number {
    return Number(this.configService.get('BATCH_PAGE_SIZE', 100));
  }

  private get apiTimeoutMs(): number {
    return Number(this.configService.get('BATCH_API_TIMEOUT_MS', 30000));
  }

  private get retryCount(): number {
    return Number(this.configService.get('BATCH_RETRY_COUNT', 1));
  }

  private getConcurrencyLimit(type: PartnerCompanyType): number {
    const key = `BATCH_CONCURRENCY_${type}`;
    return Number(this.configService.get(key, 5));
  }

  // ===== 메인 배치 메서드 (최적화 버전) =====
  async check(): Promise<BatchStatistics> {
    const stats: BatchStatistics = {
      total: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      retried: 0,
      startTime: new Date(),
    };

    this.logger.log('[check] 배치 시작');

    try {
      let lastId = Number.MAX_SAFE_INTEGER;
      let hasMore = true;

      // 1. Keyset 페이지네이션으로 데이터 조회 및 처리
      while (hasMore) {
        this.logger.log(`[check] fetchBatch 호출: lastId=${lastId}, pageSize=${this.pageSize}`);
        const batch = await this.fetchBatch(lastId, this.pageSize);
        this.logger.log(`[check] fetchBatch 결과: ${batch.length}건`);

        if (batch.length === 0) {
          this.logger.log(`[check] 더 이상 데이터 없음, 루프 종료`);
          break;
        }

        this.logger.log(`[check] 페이지 처리: lastId=${lastId}, count=${batch.length}`);

        // 2. 파트너사별 그룹핑
        const groups = this.groupByPartnerCompany(batch);

        // 3. 각 그룹 순차 처리 (그룹 내에서는 청크 병렬)
        for (const group of groups) {
          const groupStats = await this.processGroup(group);
          stats.total += groupStats.total;
          stats.success += groupStats.success;
          stats.failed += groupStats.failed;
          stats.skipped += groupStats.skipped;
          stats.retried += groupStats.retried;
        }

        // 다음 페이지를 위해 마지막 ID 갱신
        lastId = batch[batch.length - 1].id;
        hasMore = batch.length === this.pageSize;
        this.logger.log(`[check] 다음 페이지 준비: newLastId=${lastId}, hasMore=${hasMore}`);
      }
    } catch (e) {
      this.logger.error('[check] 배치 처리 중 예외 발생');
      this.logger.error(e);
    }

    stats.endTime = new Date();
    stats.durationMs = stats.endTime.getTime() - stats.startTime.getTime();

    this.logger.log(
      `[check] 배치 완료 - Total: ${stats.total}, Success: ${stats.success}, ` +
        `Failed: ${stats.failed}, Skipped: ${stats.skipped}, Retried: ${stats.retried}, ` +
        `Duration: ${stats.durationMs}ms`,
    );

    return stats;
  }

  // ===== [임시] 특정 orderId의 발송건 전체 상태조회 (일회성) =====
  async checkByOrderId(orderId: number): Promise<BatchStatistics> {
    const stats: BatchStatistics = {
      total: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      retried: 0,
      startTime: new Date(),
    };

    this.logger.log(`[checkByOrderId] 시작 - orderId=${orderId}`);

    try {
      const items = await this.fetchBatchByOrderId(orderId);
      this.logger.log(`[checkByOrderId] 대상 건수: ${items.length}`);

      const groups = this.groupByPartnerCompany(items);
      for (const group of groups) {
        const groupStats = await this.processGroup(group);
        stats.total += groupStats.total;
        stats.success += groupStats.success;
        stats.failed += groupStats.failed;
        stats.skipped += groupStats.skipped;
        stats.retried += groupStats.retried;
      }
    } catch (e) {
      this.logger.error(`[checkByOrderId] 처리 중 예외 - orderId=${orderId}`);
      this.logger.error(e);
    }

    stats.endTime = new Date();
    stats.durationMs = stats.endTime.getTime() - stats.startTime.getTime();

    this.logger.log(
      `[checkByOrderId] 완료 - orderId=${orderId}, Total: ${stats.total}, Success: ${stats.success}, ` +
        `Failed: ${stats.failed}, Skipped: ${stats.skipped}, Retried: ${stats.retried}, Duration: ${stats.durationMs}ms`,
    );

    return stats;
  }

  // ===== 특정 orderId 발송건 협력사 상태 검증 (읽기 전용, DB 변경 없음) =====
  async verifyByOrderId(orderId: number): Promise<VerifyResult> {
    this.logger.log(`[verifyByOrderId] 시작 - orderId=${orderId}`);

    const items = await this.fetchBatchByOrderId(orderId);
    const groups = this.groupByPartnerCompany(items);
    const details: VerifyItem[] = [];

    for (const group of groups) {
      for (let i = 0; i < group.items.length; i += group.concurrencyLimit) {
        const chunk = group.items.slice(i, i + group.concurrencyLimit);

        const apiResults = await Promise.allSettled(
          chunk.map((item) => this.callExternalApiWithTimeout(item, group.type)),
        );

        for (let j = 0; j < apiResults.length; j++) {
          const item = chunk[j];
          const result = apiResults[j];

          if (result.status === 'fulfilled') {
            if (result.value.skipped) continue;
            const partnerStatus = result.value.couponStatus ?? null;
            details.push({
              id: item.id,
              barCode: item.barCode ?? null,
              localStatus: item.couponStatus,
              partnerStatus,
              match: partnerStatus === null || item.couponStatus === partnerStatus,
            });
          } else {
            details.push({
              id: item.id,
              barCode: item.barCode ?? null,
              localStatus: item.couponStatus,
              partnerStatus: null,
              match: false,
              error: result.reason?.message || 'Unknown error',
            });
          }
        }
      }
    }

    let matched = 0;
    let errors = 0;
    const mismatches: VerifyItem[] = [];
    for (const d of details) {
      if (d.error) errors++;
      if (d.match) matched++;
      else mismatches.push(d);
    }

    this.logger.log(
      `[verifyByOrderId] 완료 - orderId=${orderId}, total=${details.length}, matched=${matched}, mismatched=${mismatches.length}, errors=${errors}`,
    );

    return {
      total: details.length,
      matched,
      mismatched: mismatches.length,
      errors,
      mismatches,
    };
  }

  // ===== 전체 CANCEL 상태 발송건 협력사 상태 검증 (읽기 전용, SSG 제외) =====
  async verifyAllCancelled(options?: { partnerType?: PartnerCompanyType }): Promise<VerifyResult> {
    this.logger.log(`[verifyAllCancelled] 시작 - partnerType=${options?.partnerType ?? 'ALL(비SSG)'}`);

    const mismatches: VerifyItem[] = [];
    let total = 0;
    let matched = 0;
    let errors = 0;

    let lastId = Number.MAX_SAFE_INTEGER;
    let hasMore = true;

    while (hasMore) {
      const batch = await this.fetchCancelledBatch(lastId, this.pageSize, options?.partnerType);
      if (batch.length === 0) break;

      const groups = this.groupByPartnerCompany(batch);

      for (const group of groups) {
        for (let i = 0; i < group.items.length; i += group.concurrencyLimit) {
          const chunk = group.items.slice(i, i + group.concurrencyLimit);

          const apiResults = await Promise.allSettled(
            chunk.map((item) => this.callExternalApiWithTimeout(item, group.type)),
          );

          for (let j = 0; j < apiResults.length; j++) {
            const item = chunk[j];
            const result = apiResults[j];

            if (result.status === 'fulfilled') {
              if (result.value.skipped) continue;
              total++;
              const partnerStatus = result.value.couponStatus ?? null;
              if (partnerStatus === null || item.couponStatus === partnerStatus) {
                matched++;
              } else {
                mismatches.push({
                  id: item.id,
                  barCode: item.barCode ?? null,
                  localStatus: item.couponStatus,
                  partnerStatus,
                  match: false,
                });
              }
            } else {
              total++;
              errors++;
              mismatches.push({
                id: item.id,
                barCode: item.barCode ?? null,
                localStatus: item.couponStatus,
                partnerStatus: null,
                match: false,
                error: result.reason?.message || 'Unknown error',
              });
            }
          }
        }
      }

      lastId = batch[batch.length - 1].id;
      hasMore = batch.length === this.pageSize;

      this.logger.log(
        `[verifyAllCancelled] 진행 - total=${total}, matched=${matched}, mismatched=${mismatches.length}, errors=${errors}, nextLastId=${lastId}`,
      );
    }

    this.logger.log(
      `[verifyAllCancelled] 완료 - total=${total}, matched=${matched}, mismatched=${mismatches.length}, errors=${errors}`,
    );

    return {
      total,
      matched,
      mismatched: mismatches.length,
      errors,
      mismatches,
    };
  }

  // ===== 협력사 cancel API 드라이런 (DB 변경 없이 호출만, 로그 확인용) =====
  async testCancelDryRun(orderDeliveryId: number): Promise<{ type: string; barCode: string | null; transactionId: string | null; message: string }> {
    const item = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.partnerCompany', 'choicePartnerCompany')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!item) {
      throw new BadRequestException(`orderDelivery ${orderDeliveryId} 를 찾을 수 없습니다.`);
    }

    const type = (item.choiceSelectProduct?.partnerCompany?.type ??
      item.orderProductMapping?.product?.partnerCompany?.type) as PartnerCompanyType | undefined;

    if (!type) {
      throw new BadRequestException(`partnerCompany type 을 확인할 수 없습니다.`);
    }

    this.logger.log(
      `[testCancelDryRun] 시작 - id=${orderDeliveryId}, type=${type}, barCode=${item.barCode}, transactionId=${item.transactionId}`,
    );

    switch (type) {
      case 'GALAXIA': {
        const giftKind = item.orderProductMapping.product.name.includes('(백화점)') ? 'dept' : 'cpn';
        await this.galaxia.cancel({
          transactionId: item.transactionId!,
          sendRequestAt: +format(item.sendRequestAt!, 'yyyyMMdd'),
          giftKind,
          trId: item.couponNum!,
        });
        break;
      }
      case 'CULTURELAND': {
        await this.culture.cancel({
          barCode: item.barCode!,
          expireDay: item.orderProductMapping.product.expireDay,
        });
        break;
      }
      case 'GIFT_SHOW': {
        await this.giftiShow.cancel({
          transactionId: item.transactionId!,
        });
        break;
      }
      case 'GS_M_BIZ': {
        await this.gsmbiz.cancel({
          transactionId: item.transactionId!,
          partnerCompanyCode: item.orderProductMapping.product.partnerCompanyCode!,
          barCode: item.barCode!,
        });
        break;
      }
      case 'GIFTIEL': {
        await this.giftiel.cancel({
          partnerCompanyCode: item.orderProductMapping.product.partnerCompanyCode!,
          barCode: item.barCode!,
        });
        break;
      }
      case 'DAOU': {
        const out = await this.daou.cancel({ pinNo: item.barCode! });
        this.logger.log(`[testCancelDryRun] DAOU 응답: ${JSON.stringify(out)}`);
        break;
      }
      default:
        throw new BadRequestException(`지원하지 않는 partnerType: ${type}`);
    }

    this.logger.log(`[testCancelDryRun] 완료 - id=${orderDeliveryId}`);
    return {
      type,
      barCode: item.barCode ?? null,
      transactionId: item.transactionId ?? null,
      message: '협력사 cancel API 호출 완료. 서버 로그에서 응답 본문을 확인하세요.',
    };
  }

  // ===== CANCEL 상태 발송건 조회 (Keyset 페이지네이션, SSG 제외) =====
  private async fetchCancelledBatch(
    lastId: number,
    limit: number,
    partnerType?: PartnerCompanyType,
  ): Promise<OrderDeliveryEntity[]> {
    const qb = this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.partnerCompany', 'choicePartnerCompany')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('orderDelivery.ssgEvent', 'ssgEvent')
      .where('orderDelivery.id < :lastId', { lastId })
      .andWhere('orderDelivery.couponStatus = :couponStatus', {
        couponStatus: OrderDeliveryCouponStatus.CANCEL,
      })
      .andWhere('orderDelivery.barCode IS NOT NULL')
      .andWhere('orderDelivery.deletedAt IS NULL');

    if (partnerType) {
      qb.andWhere('COALESCE(choicePartnerCompany.type, partnerCompany.type) = :partnerType', { partnerType });
    } else {
      qb.andWhere('COALESCE(choicePartnerCompany.type, partnerCompany.type) != :ssgType', {
        ssgType: PARTNER_COMPANY_TYPES.SSG,
      });
    }

    return qb.orderBy('orderDelivery.id', 'DESC').take(limit).getMany();
  }

  // ===== [임시] 특정 orderId 발송건 조회 (필터 최소화) =====
  private async fetchBatchByOrderId(orderId: number): Promise<OrderDeliveryEntity[]> {
    return this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.partnerCompany', 'choicePartnerCompany')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('orderDelivery.ssgEvent', 'ssgEvent')
      .where('orderProductMapping.orderId = :orderId', { orderId })
      .orderBy('orderDelivery.id', 'ASC')
      .getMany();
  }

  // ===== 데이터 조회 (Keyset 페이지네이션) =====
  private async fetchBatch(lastId: number, limit: number): Promise<OrderDeliveryEntity[]> {
    return this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.partnerCompany', 'choicePartnerCompany')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('orderDelivery.ssgEvent', 'ssgEvent')
      .where('orderDelivery.id < :lastId', { lastId })
      .andWhere('orderDelivery.status LIKE :status', { status: DELIVERY_STATUS_PATTERN })
      .andWhere('orderDelivery.couponStatus = :couponStatus', {
        couponStatus: OrderDeliveryCouponStatus.NOT_USED,
      })
      .andWhere('(partnerCompany.type IS NOT NULL OR orderDelivery.choiceSelectProductId IS NOT NULL)')
      .andWhere('orderDelivery.barCode IS NOT NULL')
      .orderBy('orderDelivery.id', 'DESC')
      .take(limit)
      .getMany();
  }

  // ===== 파트너사별 그룹핑 =====
  private groupByPartnerCompany(items: OrderDeliveryEntity[]): PartnerCompanyGroup[] {
    const groupMap = new Map<PartnerCompanyType, OrderDeliveryEntity[]>();

    for (const item of items) {
      const type = (item.choiceSelectProduct?.partnerCompany?.type ??
        item.orderProductMapping?.product.partnerCompany?.type) as PartnerCompanyType | undefined;

      if (!type) {
        this.logger.warn(`[groupByPartnerCompany] partnerCompany.type 없음, skip (id: ${item.id})`);
        continue;
      }

      if (!groupMap.has(type)) {
        groupMap.set(type, []);
      }
      groupMap.get(type)!.push(item);
    }

    return Array.from(groupMap.entries()).map(([type, groupItems]) => ({
      type,
      items: groupItems,
      concurrencyLimit: this.getConcurrencyLimit(type),
    }));
  }

  // ===== 그룹 처리 (청크 단위 병렬 API 호출 + 즉시 update) =====
  private async processGroup(group: PartnerCompanyGroup): Promise<BatchStatistics> {
    const stats: BatchStatistics = {
      total: group.items.length,
      success: 0,
      failed: 0,
      skipped: 0,
      retried: 0,
      startTime: new Date(),
    };

    this.logger.log(
      `[processGroup] ${group.type} 처리 시작 - count=${group.items.length}, concurrency=${group.concurrencyLimit}`,
    );

    const failedItems: Array<{ item: OrderDeliveryEntity; error: string }> = [];

    // 청크 단위로 나누어 처리
    for (let i = 0; i < group.items.length; i += group.concurrencyLimit) {
      const chunk = group.items.slice(i, i + group.concurrencyLimit);

      // Phase 1: 청크 내 API 병렬 호출
      const apiResults = await Promise.allSettled(
        chunk.map((item) => this.callExternalApiWithTimeout(item, group.type)),
      );

      // Phase 2: 성공한 건 즉시 update (청크 완료 시점)
      for (let j = 0; j < apiResults.length; j++) {
        const result = apiResults[j];
        const item = chunk[j];

        if (result.status === 'fulfilled') {
          const apiResult = result.value;

          if (apiResult.skipped) {
            stats.skipped++;
          } else {
            // 즉시 DB update
            try {
              await this.updateOrderDelivery(apiResult);
              stats.success++;
            } catch (dbError) {
              this.logger.error(`[processGroup] DB update 실패: id=${item.id}`);
              this.logger.error(dbError);
              stats.failed++;
            }
          }
        } else {
          stats.failed++;
          failedItems.push({ item, error: result.reason?.message || 'Unknown error' });
        }
      }
    }

    // 재시도 처리
    if (failedItems.length > 0 && this.retryCount > 0) {
      const retryStats = await this.retryFailedItems(failedItems, group.type);
      stats.success += retryStats.success;
      stats.failed -= retryStats.success;
      stats.retried += retryStats.retried;
    }

    stats.endTime = new Date();
    stats.durationMs = stats.endTime.getTime() - stats.startTime.getTime();

    this.logger.log(
      `[processGroup] ${group.type} 완료 - Success: ${stats.success}, Failed: ${stats.failed}, ` +
        `Skipped: ${stats.skipped}, Duration: ${stats.durationMs}ms`,
    );

    return stats;
  }

  // ===== DB update (save 대신 update 사용) =====
  private async updateOrderDelivery(result: ApiCallResult): Promise<void> {
    const updateData: Partial<OrderDeliveryEntity> = {};

    if (result.couponStatus !== undefined) {
      updateData.couponStatus = result.couponStatus;
    }
    if (result.tradeAt !== undefined) {
      updateData.tradeAt = result.tradeAt;
    }
    if (result.tradePlace !== undefined) {
      updateData.tradePlace = result.tradePlace;
    }
    if (result.galaxiaBalance !== undefined && result.galaxiaBalance !== null) {
      updateData.galaxiaBalance = result.galaxiaBalance;
    }

    await this.orderDeliveryRepository.update({ id: result.id }, updateData);
  }

  // ===== 타임아웃 래퍼 =====
  private async callExternalApiWithTimeout(
    orderDelivery: OrderDeliveryEntity,
    type: PartnerCompanyType,
  ): Promise<ApiCallResult> {
    return Promise.race([
      this.callExternalApi(orderDelivery, type),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${this.apiTimeoutMs}ms`)), this.apiTimeoutMs),
      ),
    ]);
  }

  // ===== 외부 API 호출 (DB 저장 없음) =====
  private async callExternalApi(orderDelivery: OrderDeliveryEntity, type: PartnerCompanyType): Promise<ApiCallResult> {
    const result: ApiCallResult = {
      id: orderDelivery.id,
      skipped: false,
    };

    // GALAXIA 처리
    if (type === PARTNER_COMPANY_TYPES.GALAXIA) {
      const giftKind = this.resolveGalaxiaGiftKind(orderDelivery);

      const galaxiaOut = await this.galaxia.check({
        giftKind,
        paramValue: orderDelivery.couponNum!,
      });

      if (galaxiaOut.giftCertificate.isUsed) {
        result.couponStatus = OrderDeliveryCouponStatus.USED;
      } else if (isExpiredYMD(galaxiaOut.giftCertificate.validTo)) {
        result.couponStatus = OrderDeliveryCouponStatus.EXPIRED;
      } else {
        result.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
      }
      result.tradeAt = parseDateString(galaxiaOut.giftCertificate.usedDate);
      result.galaxiaBalance = +galaxiaOut.giftCertificate.balance;
    }

    // GS_M_BIZ 처리
    if (type === 'GS_M_BIZ') {
      let partnerCompanyCode = orderDelivery.orderProductMapping.product.partnerCompanyCode!;
      if (orderDelivery.choiceSelectProduct) {
        partnerCompanyCode = orderDelivery.choiceSelectProduct.partnerCompanyCode!;
      }

      const gsMBizOut = await this.gsmbiz.check({
        transactionId: orderDelivery.transactionId!,
        partnerCompanyCode,
        barCode: orderDelivery.barCode!,
      });

      if (gsMBizOut.couponInfo.STATE === '10') {
        result.couponStatus = OrderDeliveryCouponStatus.USED;
      }
      result.tradeAt = gsMBizOut.couponInfo.USE_DT ? new Date(gsMBizOut.couponInfo.USE_DT) : null;
    }

    // GIFTIEL 처리
    if (type === 'GIFTIEL') {
      const giftielOut = await this.giftiel.check({
        partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
        barCode: orderDelivery.barCode!,
      });

      if (giftielOut.UseYn === 'Y') {
        result.couponStatus = OrderDeliveryCouponStatus.USED;
      }
      result.tradeAt = giftielOut.UseDate ? new Date(giftielOut.UseDate) : null;
      result.tradePlace = giftielOut.BiName || null;
    }

    // GIFT_SHOW 처리
    if (type === 'GIFT_SHOW') {
      const giftiShowOut = await this.giftiShow.check({
        transactionId: orderDelivery.transactionId!,
      });

      if (giftiShowOut.resCode === '0000' && giftiShowOut.couponInfo) {
        const { pinStatusCd, exchDtm, tradeBranchNm, branchNm, useComNm } = giftiShowOut.couponInfo;

        // pinStatusCd: 01=발행, 02=교환, 07=취소, 08=만료, 11=잔액기간만료
        if (pinStatusCd === '02') {
          result.couponStatus = OrderDeliveryCouponStatus.USED;
          if (exchDtm) {
            result.tradeAt = parseDateString(exchDtm);
          }
          result.tradePlace = tradeBranchNm || branchNm || useComNm || null;
        } else if (pinStatusCd === '11') {
          // 잔액기간만료: 사용 이력(exchDtm)이 있으면 교환, 없으면 만료
          if (exchDtm) {
            result.couponStatus = OrderDeliveryCouponStatus.USED;
            result.tradeAt = parseDateString(exchDtm);
            result.tradePlace = tradeBranchNm || branchNm || useComNm || null;
          } else {
            result.couponStatus = OrderDeliveryCouponStatus.EXPIRED;
          }
        } else if (pinStatusCd === '07') {
          result.couponStatus = OrderDeliveryCouponStatus.CANCEL;
        } else if (pinStatusCd === '08') {
          result.couponStatus = OrderDeliveryCouponStatus.EXPIRED;
        } else if (pinStatusCd === '01') {
          result.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
        }
      }
    }

    // CULTURELAND 처리 (60일 상품 제외)
    if (type === 'CULTURELAND') {
      let expireDay = orderDelivery.orderProductMapping.product.expireDay;
      if (orderDelivery.choiceSelectProduct) {
        expireDay = orderDelivery.choiceSelectProduct.expireDay!;
      }

      // 60일 상품은 일대사로 처리하므로 스킵
      if (expireDay === 60) {
        result.skipped = true;
        return result;
      }

      const cultureLandOut = await this.culture.check({
        scrachNo: orderDelivery.barCode!,
        certNo: orderDelivery.couponNum!,
        requestAt: orderDelivery.sendRequestAt!,
        expireDay,
      });

      // ResultCode 9006 = 유효기간 만료된 상품권
      if (cultureLandOut.ResultCode === '9006') {
        result.couponStatus = OrderDeliveryCouponStatus.EXPIRED;
      } else if (cultureLandOut.CancelPossibility === 'N') {
        result.couponStatus = OrderDeliveryCouponStatus.USED;
        result.tradeAt = new Date();
      } else {
        result.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
      }
    }

    // SSG 처리
    if (type === 'SSG') {
      if (!orderDelivery.ssgEvent) {
        throw new Error(`ssgEvent가 존재하지 않습니다. id: ${orderDelivery.id}`);
      }
      if (!orderDelivery.personalCode) {
        throw new Error(`personalCode가 존재하지 않습니다. id: ${orderDelivery.id}`);
      }

      const ssgOut = await this.ssgIssue.check({
        eventNo: orderDelivery.ssgEvent.no,
        eventSeq: orderDelivery.ssgEvent.order,
        vno: orderDelivery.personalCode!,
      });

      const isExchanged = ssgOut.response.value[0].resultCd[0] === '0400';
      if (isExchanged) {
        result.couponStatus = OrderDeliveryCouponStatus.USED;
      } else if (orderDelivery.expireAt && isExpiredYMD(formatDateYMD(orderDelivery.expireAt))) {
        result.couponStatus = OrderDeliveryCouponStatus.EXPIRED;
      } else {
        result.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
      }

      // 교환 완료 시 교환장소(payaccntNm)와 교환일시(executeDate) 저장
      if (isExchanged) {
        const payaccntNm = ssgOut.response.value[0].payaccntNm?.[0];
        const executeDate = ssgOut.response.value[0].executeDate?.[0];

        if (payaccntNm && payaccntNm.trim()) {
          result.tradePlace = payaccntNm.trim();
        }
        if (executeDate) {
          result.tradeAt = new Date(executeDate);
        }
      }
    }

    // DAOU 처리
    if (type === 'DAOU') {
      const daouCheckOut = await this.daou.check({
        barCode: orderDelivery.barCode ?? undefined,
        transactionId: orderDelivery.transactionId ?? undefined,
      });

      if (daouCheckOut.resultCode === 'S000001') {
        if (daouCheckOut.cpnStatus === '00') {
          result.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
        } else if (daouCheckOut.cpnStatus === '01' || daouCheckOut.cpnStatus === '03') {
          result.couponStatus = OrderDeliveryCouponStatus.USED;
          if (daouCheckOut.useDate) {
            result.tradeAt = parseDateString(daouCheckOut.useDate);
          }
          if (daouCheckOut.useBranch) {
            result.tradePlace = daouCheckOut.useBranch;
          }
        } else if (daouCheckOut.cpnStatus === '02') {
          result.couponStatus = OrderDeliveryCouponStatus.CANCEL;
        }
      }
    }

    return result;
  }

  // ===== 재시도 처리 =====
  private async retryFailedItems(
    failedItems: Array<{ item: OrderDeliveryEntity; error: string }>,
    type: PartnerCompanyType,
  ): Promise<{ success: number; retried: number }> {
    let success = 0;
    const retried = failedItems.length;

    this.logger.log(`[retryFailedItems] ${type} 재시도 시작 - count=${failedItems.length}`);

    for (const { item, error } of failedItems) {
      try {
        this.logger.verbose(`[retryFailedItems] 재시도: id=${item.id}, 이전 에러: ${error}`);
        const apiResult = await this.callExternalApiWithTimeout(item, type);

        if (!apiResult.skipped) {
          await this.updateOrderDelivery(apiResult);
          success++;
          this.logger.log(`[retryFailedItems] 재시도 성공: id=${item.id}`);
        }
      } catch (e) {
        this.logger.error(`[retryFailedItems] 재시도 실패: id=${item.id}`);
        this.logger.error(e);
      }
    }

    this.logger.log(`[retryFailedItems] ${type} 재시도 완료 - 성공: ${success}/${retried}`);

    return { success, retried };
  }

  // ===== 유틸리티 =====

  /**
   * 상품명 기반 giftKind 판별 (choiceSelectProduct 우선)
   */
  private resolveGalaxiaGiftKind(orderDelivery: OrderDeliveryEntity): 'dept' | 'cpn' {
    const name = orderDelivery.choiceSelectProduct?.name
      ?? orderDelivery.orderProductMapping.product.name;
    return name.includes('(백화점)') ? 'dept' : 'cpn';
  }


  /**
   * 갤럭시아 일대사(Daily Batch) - 전날 사용 내역 조회 후 tradePlace 업데이트
   * 매일 03:01에 실행
   * cpn(쿠폰), dept(백화점 상품권) 각각 조회
   * 참고: GalaxiaManagerImpl.java galaxiaCoupon_daily()
   */
  async checkGalaxiaDaily(targetDay?: string) {
    this.logger.log(`[checkGalaxiaDaily] 시작 - targetDay: ${targetDay ?? '어제'}`);

    // cpn, dept 순차 호출
    const giftKinds: Array<'cpn' | 'dept'> = ['cpn', 'dept'];

    for (const giftKind of giftKinds) {
      await this.processGalaxiaDailyByGiftKind(giftKind, targetDay);
    }

    this.logger.log('[checkGalaxiaDaily] 완료');
  }

  /**
   * giftKind별 일대사 처리
   */
  private async processGalaxiaDailyByGiftKind(giftKind: 'cpn' | 'dept', targetDay?: string) {
    this.logger.log(`[checkGalaxiaDaily] ${giftKind} 조회 시작`);

    try {
      // 갤럭시아 일대사 조회 API 호출
      const dailyResult = await this.galaxia.checkDaily({ giftKind, targetDay });

      if (dailyResult.resCode !== '0000') {
        this.logger.error(
          `[checkGalaxiaDaily] ${giftKind} API 오류: ${dailyResult.resCode} - ${dailyResult.resMsg}`,
        );
        return;
      }

      this.logger.log(`[checkGalaxiaDaily] ${giftKind} 조회된 거래 건수: ${dailyResult.transactions.length}`);

      if (dailyResult.transactions.length === 0) {
        this.logger.log(`[checkGalaxiaDaily] ${giftKind} 처리할 거래 내역이 없습니다.`);
        return;
      }

      // 각 거래 항목에 대해 order_delivery 매칭 및 사용내역 저장/tradePlace 업데이트
      for (const transaction of dailyResult.transactions) {
        try {
          // barcode로 order_delivery 검색
          const orderDelivery = await this.orderDeliveryRepository.findOne({
            where: {
              barCode: transaction.barcode,
            },
          });

          if (!orderDelivery) {
            this.logger.verbose(
              `[checkGalaxiaDaily] ${giftKind} 매칭되는 order_delivery 없음: barcode=${transaction.barcode}`,
            );
            continue;
          }

          // 사용내역 중복 체크 후 저장 (별도 try-catch로 tradePlace 업데이트에 영향 주지 않도록)
          try {
            const dedupQuery = this.galaxiaBarcodeLogRepository
              .createQueryBuilder('log')
              .where('log.barcode = :barcode', { barcode: transaction.barcode })
              .andWhere('log.appDiv = :appDiv', { appDiv: transaction.appDiv })
              .andWhere('log.appDay = :appDay', { appDay: transaction.appDay })
              .andWhere('log.appTime = :appTime', { appTime: transaction.appTime });

            if (transaction.appNo != null) {
              dedupQuery.andWhere('log.appNo = :appNo', { appNo: transaction.appNo });
            } else {
              dedupQuery.andWhere('log.appNo IS NULL');
            }

            const existingLog = await dedupQuery.getOne();

            if (!existingLog) {
              await this.galaxiaBarcodeLogRepository.save({
                orderDeliveryId: orderDelivery.id,
                barcode: transaction.barcode,
                appDiv: transaction.appDiv,
                appDay: transaction.appDay,
                appTime: transaction.appTime,
                amount: parseInt(transaction.amount, 10),
                appNo: transaction.appNo ?? null,
                appStore: transaction.appStore?.trim() || null,
                giftKind,
              });

              this.logger.log(
                `[checkGalaxiaDaily] ${giftKind} 사용내역 저장: orderDeliveryId=${orderDelivery.id}, appDiv=${transaction.appDiv}, appDay=${transaction.appDay}, amount=${transaction.amount}`,
              );
            }
          } catch (logError) {
            this.logger.error(
              `[checkGalaxiaDaily] ${giftKind} 사용내역 저장 실패: orderDeliveryId=${orderDelivery.id}, barcode=${transaction.barcode}`,
            );
            this.logger.error(logError);
          }

          // tradePlace 업데이트 (기존 로직 유지)
          if (transaction.appStore && transaction.appStore.trim()) {
            orderDelivery.tradePlace = transaction.appStore.trim();
            await this.orderDeliveryRepository.save(orderDelivery);

            this.logger.log(
              `[checkGalaxiaDaily] ${giftKind} tradePlace 업데이트: orderDeliveryId=${orderDelivery.id}, appStore=${transaction.appStore}`,
            );
          }
        } catch (e) {
          this.logger.error(`[checkGalaxiaDaily] ${giftKind} 거래 처리 오류: barcode=${transaction.barcode}`);
          this.logger.error(e);
        }
      }

      this.logger.log(`[checkGalaxiaDaily] ${giftKind} 처리 완료`);
    } catch (e) {
      this.logger.error(`[checkGalaxiaDaily] ${giftKind} 실행 오류`);
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
    }
  }

  /**
   * 갤럭시아 실시간 Push 거래 처리
   * 갤럭시아가 사용 이벤트 발생 시 XML로 전송하는 개별 transaction 처리
   */
  async processGalaxiaPush(
    raw: GalaxiaPushRawTransaction,
    giftKind: 'cpn' | 'dept' | null,
  ): Promise<'saved' | 'skipped'> {
    // 1. 복호화
    const barcode = this.cryptoCipher.decrypt(raw.barcode, this.galaxiaEncKey, this.galaxiaEncIv, this.galaxiaEncAlgorithm);
    const amount = this.cryptoCipher.decrypt(raw.amount, this.galaxiaEncKey, this.galaxiaEncIv, this.galaxiaEncAlgorithm);
    const remainprice = this.cryptoCipher.decrypt(raw.remainprice, this.galaxiaEncKey, this.galaxiaEncIv, this.galaxiaEncAlgorithm);

    // 2. storename URL 디코딩
    const storename = raw.storename ? decodeURIComponent(raw.storename) : null;

    // 3. appNo가 없으면 synthetic appNo 생성
    const appNo = raw.appno || this.generateSyntheticAppNo(barcode, raw.apptime);

    // 4. barCode로 orderDelivery 매칭
    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: { barCode: barcode },
    });

    if (!orderDelivery) {
      this.logger.verbose(`[galaxiaPush] 매칭 order_delivery 없음: barcode=${barcode}`);
      return 'skipped';
    }

    // 5. 중복 체크
    const dedupQuery = this.galaxiaBarcodeLogRepository
      .createQueryBuilder('log')
      .where('log.barcode = :barcode', { barcode })
      .andWhere('log.appDiv = :appDiv', { appDiv: raw.appdiv })
      .andWhere('log.appDay = :appDay', { appDay: raw.appday })
      .andWhere('log.appTime = :appTime', { appTime: raw.apptime });

    if (appNo != null) {
      dedupQuery.andWhere('log.appNo = :appNo', { appNo });
    } else {
      dedupQuery.andWhere('log.appNo IS NULL');
    }

    const existingLog = await dedupQuery.getOne();

    if (existingLog) {
      this.logger.verbose(
        `[galaxiaPush] 중복 스킵: barcode=${barcode}, appDiv=${raw.appdiv}, appDay=${raw.appday}`,
      );
      return 'skipped';
    }

    // 6. galaxia_barcode_log 저장
    await this.galaxiaBarcodeLogRepository.save({
      orderDeliveryId: orderDelivery.id,
      barcode,
      appDiv: raw.appdiv,
      appDay: raw.appday,
      appTime: raw.apptime,
      amount: parseInt(amount, 10),
      appNo: appNo ?? null,
      appStore: storename?.trim() || null,
      giftKind: giftKind ?? 'cpn',
    });

    // 7. orderDelivery 상태 업데이트
    const galaxiaBalance = parseInt(remainprice, 10);

    switch (raw.appdiv) {
      case '10': // 사용
        orderDelivery.couponStatus = OrderDeliveryCouponStatus.USED;
        orderDelivery.tradeAt = this.parseGalaxiaDateTime(raw.appday, raw.apptime);
        orderDelivery.tradePlace = storename?.trim() || orderDelivery.tradePlace;
        orderDelivery.galaxiaBalance = galaxiaBalance;
        break;
      case '20': // 사용취소
      case '25': // 망취소
        orderDelivery.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
        orderDelivery.tradeAt = null;
        orderDelivery.galaxiaBalance = galaxiaBalance;
        break;
      case '81': // 환불등록
        orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
        orderDelivery.galaxiaBalance = 0;
        break;
    }

    await this.orderDeliveryRepository.save(orderDelivery);

    this.logger.log(
      `[galaxiaPush] 처리 완료: orderDeliveryId=${orderDelivery.id}, appDiv=${raw.appdiv}, amount=${amount}`,
    );
    return 'saved';
  }

  private generateSyntheticAppNo(barcode: string, appTime: string): string {
    const suffix = barcode.slice(-5);
    return `nav${suffix}${appTime}${this.randomString(3)}`;
  }

  private parseGalaxiaDateTime(appDay: string, appTime: string): Date {
    // appDay: YYYYMMDD, appTime: HHmmss
    const year = parseInt(appDay.substring(0, 4), 10);
    const month = parseInt(appDay.substring(4, 6), 10) - 1;
    const day = parseInt(appDay.substring(6, 8), 10);
    const hour = parseInt(appTime.substring(0, 2), 10);
    const minute = parseInt(appTime.substring(2, 4), 10);
    const second = parseInt(appTime.substring(4, 6), 10);
    return new Date(year, month, day, hour, minute, second);
  }

  /**
   * 컬쳐랜드 일대사(Daily Batch) - 60일 상품 전용
   * 전날 사용된 상품권 목록 조회 후 교환 처리
   * 매일 07:15에 실행 (컬쳐랜드 점검시간 06:01~06:59 이후)
   */
  async checkCulturelandDaily(useDate?: string) {
    this.logger.log(`[checkCulturelandDaily] 시작 - useDate: ${useDate ?? '어제'}`);

    try {
      // 컬쳐랜드 일대사 API 호출 (60일 상품 계정)
      const dailyResult = await this.culture.checkDaily({ useDate });

      this.logger.log(`[checkCulturelandDaily] 조회된 certNo 건수: ${dailyResult.certNoList.length}`);

      if (dailyResult.certNoList.length === 0) {
        this.logger.log('[checkCulturelandDaily] 처리할 사용 내역 없음 - 만료 처리만 진행합니다.');
      }

      // 각 certNo에 대해 order_delivery 매칭 및 교환 처리
      for (const certNo of dailyResult.certNoList) {
        try {
          // certNo로 order_delivery 검색 (60일 상품만 대상)
          const orderDelivery = await this.orderDeliveryRepository
            .createQueryBuilder('od')
            .innerJoinAndSelect('od.orderProductMapping', 'opm')
            .innerJoinAndSelect('opm.product', 'p')
            .innerJoinAndSelect('p.partnerCompany', 'pc')
            .where('od.couponNum = :certNo', { certNo })
            .andWhere('od.couponStatus = :status', { status: OrderDeliveryCouponStatus.NOT_USED })
            .andWhere('pc.type = :type', { type: 'CULTURELAND' })
            .andWhere('p.expireDay = :expireDay', { expireDay: 60 })
            .getOne();

          if (!orderDelivery) {
            this.logger.verbose(`[checkCulturelandDaily] 매칭되는 order_delivery 없음: certNo=${certNo}`);
            continue;
          }

          // 교환 처리
          orderDelivery.couponStatus = OrderDeliveryCouponStatus.USED;
          // 사용일 설정 (useDate 파싱)
          const useDateStr = dailyResult.useDate;
          orderDelivery.tradeAt = new Date(
            parseInt(useDateStr.substring(0, 4)),
            parseInt(useDateStr.substring(4, 6)) - 1,
            parseInt(useDateStr.substring(6, 8)),
          );

          await this.orderDeliveryRepository.save(orderDelivery);

          this.logger.log(
            `[checkCulturelandDaily] 교환 처리 완료: orderDeliveryId=${orderDelivery.id}, certNo=${certNo}`,
          );
        } catch (e) {
          this.logger.error(`[checkCulturelandDaily] 처리 오류: certNo=${certNo}`);
          this.logger.error(e);
        }
      }

      // 60일 컬쳐랜드 NOT_USED 중 expire_at 지난 건 EXPIRED 처리
      const expiredTargets = await this.orderDeliveryRepository
        .createQueryBuilder('od')
        .select('od.id', 'id')
        .innerJoin('od.orderProductMapping', 'opm')
        .innerJoin('opm.product', 'p')
        .innerJoin('p.partnerCompany', 'pc')
        .where('od.couponStatus = :status', { status: OrderDeliveryCouponStatus.NOT_USED })
        .andWhere('pc.type = :type', { type: 'CULTURELAND' })
        .andWhere('p.expireDay = :expireDay', { expireDay: 60 })
        .andWhere('od.expireAt IS NOT NULL')
        .andWhere('od.expireAt < NOW()')
        .getRawMany<{ id: number }>();

      if (expiredTargets.length > 0) {
        const expiredIds = expiredTargets.map((t) => t.id);
        await this.orderDeliveryRepository.update(
          { id: In(expiredIds) },
          { couponStatus: OrderDeliveryCouponStatus.EXPIRED },
        );
        this.logger.log(`[checkCulturelandDaily] 만료 처리 건수: ${expiredIds.length}`);
      } else {
        this.logger.log('[checkCulturelandDaily] 만료 처리 대상 없음');
      }

      this.logger.log('[checkCulturelandDaily] 완료');
    } catch (e) {
      this.logger.error('[checkCulturelandDaily] 실행 오류');
      this.logger.error(e);
      this.logger.error(JSON.stringify(e));
    }
  }

  /**
   * 갤럭시아 백화점(dept) 상품 사용내역 야간 배치
   * 매일 23:42에 실행 - 백화점 상품 배송건을 개별 상태조회하여 잔액 변동 감지
   * 일대사(checkGalaxiaDaily)는 cpn 상품에는 충분하지만, dept 상품의 사용내역(네이버페이 등)은 누락됨
   */
  async checkGalaxiaDeptUsage(): Promise<void> {
    this.logger.log('[checkGalaxiaDeptUsage] 배치 시작');

    let lastId = Number.MAX_SAFE_INTEGER;
    let hasMore = true;
    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    try {
      while (hasMore) {
        const batch = await this.fetchGalaxiaDeptBatch(lastId, this.pageSize);

        if (batch.length === 0) {
          break;
        }

        this.logger.log(
          `[checkGalaxiaDeptUsage] 페이지 처리: lastId=${lastId}, count=${batch.length}`,
        );

        const concurrency = this.getConcurrencyLimit('GALAXIA');

        for (let i = 0; i < batch.length; i += concurrency) {
          const chunk = batch.slice(i, i + concurrency);
          const results = await Promise.allSettled(
            chunk.map((item) => this.processGalaxiaDeptItem(item)),
          );

          for (let j = 0; j < results.length; j++) {
            totalProcessed++;
            const result = results[j];

            if (result.status === 'fulfilled') {
              if (result.value === 'updated') totalUpdated++;
              else totalSkipped++;
            } else {
              totalFailed++;
              this.logger.error(
                `[checkGalaxiaDeptUsage] 처리 실패: id=${chunk[j].id}`,
              );
              this.logger.error(result.reason);
            }
          }
        }

        lastId = batch[batch.length - 1].id;
        hasMore = batch.length === this.pageSize;
      }
    } catch (e) {
      this.logger.error('[checkGalaxiaDeptUsage] 배치 처리 중 예외 발생');
      this.logger.error(e);
    }

    this.logger.log(
      `[checkGalaxiaDeptUsage] 배치 완료 - 처리: ${totalProcessed}, 업데이트: ${totalUpdated}, ` +
        `스킵: ${totalSkipped}, 실패: ${totalFailed}`,
    );
  }

  /**
   * 갤럭시아 백화점 상품 대상 조회 (Keyset 페이지네이션)
   * NOT_USED → 첫 사용 감지 / USED + galaxiaBalance > 0 → 추가 사용 감지
   */
  private async fetchGalaxiaDeptBatch(lastId: number, limit: number): Promise<OrderDeliveryEntity[]> {
    return this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .where('orderDelivery.id < :lastId', { lastId })
      .andWhere('orderDelivery.status LIKE :status', { status: DELIVERY_STATUS_PATTERN })
      .andWhere('orderDelivery.barCode IS NOT NULL')
      .andWhere('orderDelivery.couponNum IS NOT NULL')
      .andWhere('partnerCompany.type = :type', { type: PARTNER_COMPANY_TYPES.GALAXIA })
      .andWhere(
        new Brackets((qb) => {
          qb.where('orderDelivery.couponStatus = :notUsed', {
            notUsed: OrderDeliveryCouponStatus.NOT_USED,
          }).orWhere(
            new Brackets((qb2) => {
              qb2
                .where('orderDelivery.couponStatus = :used', {
                  used: OrderDeliveryCouponStatus.USED,
                })
                .andWhere('orderDelivery.galaxiaBalance > 0');
            }),
          );
        }),
      )
      .andWhere(
        new Brackets((qb) => {
          qb.where('product.name LIKE :deptPattern', { deptPattern: '%(백화점)%' }).orWhere(
            'choiceSelectProduct.name LIKE :deptPattern2',
            { deptPattern2: '%(백화점)%' },
          );
        }),
      )
      .orderBy('orderDelivery.id', 'DESC')
      .take(limit)
      .getMany();
  }

  /**
   * 갤럭시아 백화점 상품 개별 처리 - check API 호출 후 잔액 변동 감지
   */
  private async processGalaxiaDeptItem(
    orderDelivery: OrderDeliveryEntity,
  ): Promise<'updated' | 'skipped'> {
    // 1. giftKind 판별 (choiceSelectProduct 우선)
    const giftKind = this.resolveGalaxiaGiftKind(orderDelivery);

    // 2. 갤럭시아 check API 호출
    const galaxiaOut = await this.galaxia.check({
      giftKind,
      paramValue: orderDelivery.couponNum!,
    });

    const currentBalance = +galaxiaOut.giftCertificate.balance;

    // 3. 이전 잔액 결정
    let previousBalance: number;
    if (orderDelivery.couponStatus === OrderDeliveryCouponStatus.NOT_USED) {
      // 첫 사용 감지: 상품 액면가(faceValue)와 비교
      const product = orderDelivery.choiceSelectProduct ?? orderDelivery.orderProductMapping.product;
      previousBalance = product.price;
    } else {
      // 추가 사용 감지: 저장된 galaxiaBalance와 비교
      previousBalance = orderDelivery.galaxiaBalance;
    }

    // 4. 잔액 변동 확인
    if (currentBalance >= previousBalance) {
      return 'skipped';
    }

    // 5. 사용 감지 - galaxia_barcode_log 저장
    const now = new Date();
    const appDay = formatDateYMD(now);
    const appTime = this.formatTimeHMS(now);
    const usedAmount = previousBalance - currentBalance;
    const appNo = `chk${orderDelivery.barCode!.slice(-5)}${appTime}${this.randomString(3)}`;

    await this.galaxiaBarcodeLogRepository.save({
      orderDeliveryId: orderDelivery.id,
      barcode: orderDelivery.barCode!,
      appDiv: '10',
      appDay,
      appTime,
      amount: usedAmount,
      appNo,
      appStore: null,
      giftKind: 'dept',
    });

    // 6. orderDelivery 업데이트
    const updateData: Partial<OrderDeliveryEntity> = {
      galaxiaBalance: currentBalance,
    };

    if (galaxiaOut.giftCertificate.isUsed) {
      updateData.couponStatus = OrderDeliveryCouponStatus.USED;
      updateData.tradeAt = parseDateString(galaxiaOut.giftCertificate.usedDate);
    }

    if (galaxiaOut.giftCertificate.couponStatus === 'CANCEL') {
      updateData.couponStatus = OrderDeliveryCouponStatus.CANCEL;
    }

    await this.orderDeliveryRepository.update({ id: orderDelivery.id }, updateData);

    this.logger.log(
      `[checkGalaxiaDeptUsage] 사용 감지: id=${orderDelivery.id}, ` +
        `이전잔액=${previousBalance}, 현재잔액=${currentBalance}, 사용액=${usedAmount}`,
    );

    return 'updated';
  }


  private formatTimeHMS(date: Date): string {
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${h}${m}${s}`;
  }

  private randomString(length: number): string {
    return Math.random()
      .toString(36)
      .substring(2, 2 + length);
  }

  // ===== 갤럭시아 바코드 로그 백필 =====

  /**
   * 사용(USED) 상태인데 galaxia_barcode_log가 없는 GALAXIA 주문을
   * 개별 check API로 조회하여 바코드 로그를 채운다.
   * 일대사 API에서 누락된 상품(SK모바일주유권, 다이소, 네이버페이 등) 대상.
   */
  async backfillMissingGalaxiaLogs(): Promise<{
    totalProcessed: number;
    totalCreated: number;
    totalSkipped: number;
    totalFailed: number;
  }> {
    this.logger.log('[backfillGalaxia] 백필 시작');

    let lastId = Number.MAX_SAFE_INTEGER;
    let hasMore = true;
    let totalProcessed = 0;
    let totalCreated = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    try {
      while (hasMore) {
        const batch = await this.fetchMissingGalaxiaLogBatch(lastId, this.pageSize);

        if (batch.length === 0) break;

        this.logger.log(
          `[backfillGalaxia] 페이지 처리: lastId=${lastId}, count=${batch.length}`,
        );

        const concurrency = this.getConcurrencyLimit('GALAXIA');

        for (let i = 0; i < batch.length; i += concurrency) {
          const chunk = batch.slice(i, i + concurrency);
          const results = await Promise.allSettled(
            chunk.map((item) => this.processBackfillItem(item)),
          );

          for (let j = 0; j < results.length; j++) {
            totalProcessed++;
            const result = results[j];

            if (result.status === 'fulfilled') {
              if (result.value === 'created') totalCreated++;
              else totalSkipped++;
            } else {
              totalFailed++;
              this.logger.error(
                `[backfillGalaxia] 처리 실패: id=${chunk[j].id}`,
              );
              this.logger.error(result.reason);
            }
          }
        }

        lastId = batch[batch.length - 1].id;
        hasMore = batch.length === this.pageSize;
      }
    } catch (e) {
      this.logger.error('[backfillGalaxia] 배치 처리 중 예외 발생');
      this.logger.error(e);
    }

    const summary = { totalProcessed, totalCreated, totalSkipped, totalFailed };
    this.logger.log(
      `[backfillGalaxia] 백필 완료 - 처리: ${totalProcessed}, 생성: ${totalCreated}, ` +
        `스킵: ${totalSkipped}, 실패: ${totalFailed}`,
    );
    return summary;
  }

  /**
   * GALAXIA + USED + barCode/couponNum 있음 + galaxia_barcode_log 없음 대상 조회
   */
  private async fetchMissingGalaxiaLogBatch(
    lastId: number,
    limit: number,
  ): Promise<OrderDeliveryEntity[]> {
    return this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.partnerCompany', 'choicePartnerCompany')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoin('galaxia_barcode_log', 'gbl', 'gbl.order_delivery_id = orderDelivery.id')
      .where('orderDelivery.id < :lastId', { lastId })
      .andWhere('orderDelivery.status LIKE :status', { status: DELIVERY_STATUS_PATTERN })
      .andWhere('orderDelivery.barCode IS NOT NULL')
      .andWhere('orderDelivery.couponNum IS NOT NULL')
      .andWhere(
        new Brackets((qb) =>
          qb
            .where('partnerCompany.type = :galaxiaType', { galaxiaType: PARTNER_COMPANY_TYPES.GALAXIA })
            .orWhere('choicePartnerCompany.type = :galaxiaType', { galaxiaType: PARTNER_COMPANY_TYPES.GALAXIA }),
        ),
      )
      .andWhere('orderDelivery.couponStatus IN (:...statuses)', {
        statuses: [OrderDeliveryCouponStatus.USED, OrderDeliveryCouponStatus.CANCEL],
      })
      .andWhere('gbl.id IS NULL')
      .orderBy('orderDelivery.id', 'DESC')
      .take(limit)
      .getMany();
  }

  /**
   * 개별 order_delivery에 대해 check API 호출 → 사용내역이면 barcode_log 생성
   */
  private async processBackfillItem(
    orderDelivery: OrderDeliveryEntity,
  ): Promise<'created' | 'skipped'> {
    const giftKind = this.resolveGalaxiaGiftKind(orderDelivery);

    const galaxiaOut = await this.galaxia.check({
      giftKind,
      paramValue: orderDelivery.couponNum!,
    });

    if (!galaxiaOut.giftCertificate.isUsed && galaxiaOut.giftCertificate.couponStatus !== 'CANCEL') {
      return 'skipped';
    }

    const faceValue = +galaxiaOut.giftCertificate.faceValue;
    const balance = +galaxiaOut.giftCertificate.balance;
    const usedAmount = faceValue - balance;

    if (usedAmount <= 0) {
      return 'skipped';
    }

    // usedDate에서 appDay/appTime 추출 (형식: YYYYMMDDHHmmss)
    const usedDate = galaxiaOut.giftCertificate.usedDate || '';
    const appDay = usedDate.substring(0, 8) || formatDateYMD(new Date());
    const appTime = usedDate.substring(8, 14) || this.formatTimeHMS(new Date());

    const appNo = `bkf${orderDelivery.barCode!.slice(-5)}${appTime}${this.randomString(3)}`;

    // 중복 체크
    const existing = await this.galaxiaBarcodeLogRepository
      .createQueryBuilder('log')
      .where('log.orderDeliveryId = :odId', { odId: orderDelivery.id })
      .getOne();

    if (existing) {
      return 'skipped';
    }

    await this.galaxiaBarcodeLogRepository.save({
      orderDeliveryId: orderDelivery.id,
      barcode: orderDelivery.barCode!,
      appDiv: '10',
      appDay,
      appTime,
      amount: usedAmount,
      appNo,
      appStore: null,
      giftKind,
    });

    // galaxiaBalance도 업데이트
    await this.orderDeliveryRepository.update(
      { id: orderDelivery.id },
      { galaxiaBalance: balance },
    );

    this.logger.log(
      `[backfillGalaxia] 로그 생성: id=${orderDelivery.id}, ` +
        `appDay=${appDay}, amount=${usedAmount}, giftKind=${giftKind}`,
    );

    return 'created';
  }
}
