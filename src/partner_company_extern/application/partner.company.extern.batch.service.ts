import { Inject, Injectable, Logger } from '@nestjs/common';
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
import { Brackets, Repository } from 'typeorm';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import {
  PartnerCompanyType,
  ApiCallResult,
  BatchStatistics,
  PartnerCompanyGroup,
} from './partner.company.extern.batch.types';
import { GalaxiaBarcodeLogEntity } from '../../entity/galaxia.barcode.log.entity';

// ===== 상수 정의 =====
const COUPON_STATUS_VALUES = {
  NOT_USED: 'NOT_USED',
  USED: 'USED',
  CANCEL: 'CANCEL',
} as const;

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

  // ===== 데이터 조회 (Keyset 페이지네이션) =====
  private async fetchBatch(lastId: number, limit: number): Promise<OrderDeliveryEntity[]> {
    return this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('orderDelivery.ssgEvent', 'ssgEvent')
      .where('orderDelivery.id < :lastId', { lastId })
      .andWhere('orderDelivery.status LIKE :status', { status: DELIVERY_STATUS_PATTERN })
      .andWhere('orderDelivery.couponStatus = :couponStatus', {
        couponStatus: COUPON_STATUS_VALUES.NOT_USED,
      })
      .andWhere('partnerCompany.type IS NOT NULL')
      .andWhere('orderDelivery.barCode IS NOT NULL')
      .orderBy('orderDelivery.id', 'DESC')
      .take(limit)
      .getMany();
  }

  // ===== 파트너사별 그룹핑 =====
  private groupByPartnerCompany(items: OrderDeliveryEntity[]): PartnerCompanyGroup[] {
    const groupMap = new Map<PartnerCompanyType, OrderDeliveryEntity[]>();

    for (const item of items) {
      const type = item.orderProductMapping!.product.partnerCompany!.type as PartnerCompanyType;

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

      result.couponStatus = galaxiaOut.giftCertificate.isUsed
        ? OrderDeliveryCouponStatus.USED
        : OrderDeliveryCouponStatus.NOT_USED;
      result.tradeAt = this.parseDateString(galaxiaOut.giftCertificate.usedDate);
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

        if (pinStatusCd === '02') {
          result.couponStatus = OrderDeliveryCouponStatus.USED;
          if (exchDtm) {
            result.tradeAt = this.parseDateString(exchDtm);
          }
          result.tradePlace = tradeBranchNm || branchNm || useComNm || null;
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

      result.couponStatus =
        cultureLandOut.CancelPossibility === 'N'
          ? OrderDeliveryCouponStatus.USED
          : OrderDeliveryCouponStatus.NOT_USED;
      if (cultureLandOut.CancelPossibility === 'N') {
        result.tradeAt = new Date();
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
      result.couponStatus = isExchanged ? OrderDeliveryCouponStatus.USED : OrderDeliveryCouponStatus.NOT_USED;

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
        transactionId: orderDelivery.transactionId!,
      });

      if (daouCheckOut.resultCode === 'S000001') {
        if (daouCheckOut.cpnStatus === '01' || daouCheckOut.cpnStatus === '03') {
          result.couponStatus = OrderDeliveryCouponStatus.USED;
          if (daouCheckOut.useDate) {
            result.tradeAt = this.parseDateString(daouCheckOut.useDate);
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
   * 날짜 문자열(YYYYMMDD 또는 YYYYMMDDHHmmss)을 Date 객체로 변환
   */
  private parseDateString(dateStr: string | null | undefined): Date | null {
    if (!dateStr || dateStr.length < 8) {
      return null;
    }

    const year = parseInt(dateStr.substring(0, 4));
    const month = parseInt(dateStr.substring(4, 6)) - 1;
    const day = parseInt(dateStr.substring(6, 8));
    const hour = dateStr.length >= 10 ? parseInt(dateStr.substring(8, 10)) : 0;
    const minute = dateStr.length >= 12 ? parseInt(dateStr.substring(10, 12)) : 0;
    const second = dateStr.length >= 14 ? parseInt(dateStr.substring(12, 14)) : 0;

    return new Date(year, month, day, hour, minute, second);
  }

  // ===== 기존 check() 메서드 백업 (롤백용) =====
  async checkLegacy() {
    const orderDeliveryList = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('orderDelivery.ssgEvent', 'ssgEvent')
      .where('orderDelivery.status LIKE :status', { status: `COMPLETE%` })
      .andWhere('orderDelivery.couponStatus = :couponStatus', { couponStatus: 'NOT_USED' })
      .andWhere('partnerCompany.type IS NOT NULL')
      .andWhere('orderDelivery.barCode IS NOT NULL')
      .orderBy('orderDelivery.id', 'DESC')
      .getMany();

    for (const orderDelivery of orderDeliveryList) {
      try {
        const type = orderDelivery.orderProductMapping!.product.partnerCompany!.type;

        this.logger.verbose(type);
        if (type === 'GALAXIA') {
          let giftKind: 'dept' | 'cpn' = orderDelivery.orderProductMapping.product.name.includes('(백화점)')
            ? 'dept'
            : 'cpn';

          if (orderDelivery.choiceSelectProduct) {
            giftKind = orderDelivery.choiceSelectProduct.name.includes('(백화점)') ? 'dept' : 'cpn';
          }

          const galaxiaOut = await this.galaxia.check({
            giftKind,
            paramValue: orderDelivery.couponNum!, // trId
          });
          orderDelivery.couponStatus = galaxiaOut.giftCertificate.isUsed
            ? OrderDeliveryCouponStatus.USED
            : OrderDeliveryCouponStatus.NOT_USED;
          orderDelivery.tradeAt = galaxiaOut.giftCertificate.usedDate
            ? new Date(galaxiaOut.giftCertificate.usedDate)
            : null;
          orderDelivery.galaxiaBalance = +galaxiaOut.giftCertificate.balance;
        }

        // 1.1.2 GSMBIZ 쿠폰 조회
        // GSM쿠폰_전문사양서_고객사_표준V3.4_20200529.pdf
        if (type === 'GS_M_BIZ') {
          let partnerCompanyCode = orderDelivery.orderProductMapping.product.partnerCompanyCode!;
          if (orderDelivery.choiceSelectProduct) {
            partnerCompanyCode = orderDelivery.choiceSelectProduct.partnerCompanyCode!;
          }

          const gsMBizOut = await this.gsmbiz.check({
            transactionId: orderDelivery.transactionId!,
            partnerCompanyCode: partnerCompanyCode,
            barCode: orderDelivery.barCode!,
          });
          orderDelivery.couponStatus =
            gsMBizOut.couponInfo.STATE === '10' ? OrderDeliveryCouponStatus.USED : orderDelivery.couponStatus;
          orderDelivery.tradeAt = gsMBizOut.couponInfo.USE_DT ? new Date(gsMBizOut.couponInfo.USE_DT) : null;
        }

        // 1.1.3 Giftiel 쿠폰 조회
        // giftiel(기프티엘)_공통_판매사_연동가이드_v2.1.0.0_20210409.pdf
        if (type === 'GIFTIEL') {
          const giftielOut = await this.giftiel.check({
            partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
            barCode: orderDelivery.barCode!,
          });

          orderDelivery.couponStatus =
            giftielOut.UseYn === 'Y' ? OrderDeliveryCouponStatus.USED : orderDelivery.couponStatus;
          orderDelivery.tradeAt = giftielOut.UseDate ? new Date(giftielOut.UseDate) : null;
          orderDelivery.tradePlace = giftielOut.BiName || null;
        }

        // 1.1.4 giftshow 쿠폰 조회 (V2 API)
        if (type === 'GIFT_SHOW') {
          const giftiShowOut = await this.giftiShow.check({
            transactionId: orderDelivery.transactionId!,
          });

          if (giftiShowOut.resCode === '0000' && giftiShowOut.couponInfo) {
            const { pinStatusCd, exchDtm, tradeBranchNm, branchNm, useComNm } = giftiShowOut.couponInfo;

            // pinStatusCd: 01=발행, 02=교환, 07=취소, 08=만료
            if (pinStatusCd === '02') {
              orderDelivery.couponStatus = OrderDeliveryCouponStatus.USED;
              // 교환일시 파싱 (YYYYMMDDHHmmss)
              if (exchDtm) {
                const year = parseInt(exchDtm.substring(0, 4));
                const month = parseInt(exchDtm.substring(4, 6)) - 1;
                const day = parseInt(exchDtm.substring(6, 8));
                const hour = parseInt(exchDtm.substring(8, 10));
                const minute = parseInt(exchDtm.substring(10, 12));
                const second = parseInt(exchDtm.substring(12, 14));
                orderDelivery.tradeAt = new Date(year, month, day, hour, minute, second);
              }
              // 교환장소: tradeBranchNm > branchNm > useComNm 순으로 사용
              orderDelivery.tradePlace = tradeBranchNm || branchNm || useComNm || null;
            } else if (pinStatusCd === '01') {
              orderDelivery.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
            }
          }
        }

        // 1.1.5 컬쳐랜드 쿠폰 조회
        // 컬쳐랜드상품권(모바일문화상품권)_구매_연동가이드_V3.0.pdf
        // 60일 상품은 일대사(07:15 배치)로 처리하므로 제외
        if (type === 'CULTURELAND') {
          let expireDay = orderDelivery.orderProductMapping.product.expireDay;
          if (orderDelivery.choiceSelectProduct) {
            expireDay = orderDelivery.choiceSelectProduct.expireDay!;
          }

          // 60일 상품은 일대사로 처리
          if (expireDay === 60) {
            continue;
          }

          const cultureLandOut = await this.culture.check({
            scrachNo: orderDelivery.barCode!,
            certNo: orderDelivery.couponNum!, // 상품권 관리번호
            requestAt: orderDelivery.sendRequestAt!,
            expireDay,
          });
          orderDelivery.couponStatus =
            cultureLandOut.CancelPossibility == 'N'
              ? OrderDeliveryCouponStatus.USED
              : OrderDeliveryCouponStatus.NOT_USED;
          if (cultureLandOut.CancelPossibility === 'N') {
            orderDelivery.tradeAt = new Date();
          }
        }

        // 1.1.6 신세계 상품권 발행
        if (type === 'SSG') {
          if (!orderDelivery.ssgEvent) {
            throw new Error(
              `id: ${orderDelivery.id} ssgEventId: ${orderDelivery.ssgEventId} ssg event 가 존재하지 않습니다.`,
            );
          }
          if (!orderDelivery.personalCode) {
            throw new Error(`personalCode가 존재하지 않습니다.`);
          }

          const ssgOut = await this.ssgIssue.check({
            eventNo: orderDelivery.ssgEvent.no,
            eventSeq: orderDelivery.ssgEvent.order,
            vno: orderDelivery.personalCode!,
          });
          orderDelivery.couponStatus =
            ssgOut.response.value[0].resultCd[0] == '0400'
              ? OrderDeliveryCouponStatus.USED
              : OrderDeliveryCouponStatus.NOT_USED;
        }

        // 1.1.7 다우기술 쿠폰 조회
        if (type === 'DAOU') {
          const daouCheckOut = await this.daou.check({
            transactionId: orderDelivery.transactionId!,
          });

          if (daouCheckOut.resultCode === 'S000001') {
            // CPN_STATUS: 00(미사용), 01(교환완료), 02(기취소), 03(사용중)
            if (daouCheckOut.cpnStatus === '01' || daouCheckOut.cpnStatus === '03') {
              // 01: 교환완료, 03: 사용중 - 둘 다 USED로 처리
              orderDelivery.couponStatus = OrderDeliveryCouponStatus.USED;
              // 사용일자가 있으면 tradeAt에 설정 (YYYYMMDD 형식)
              if (daouCheckOut.useDate) {
                const year = parseInt(daouCheckOut.useDate.substring(0, 4));
                const month = parseInt(daouCheckOut.useDate.substring(4, 6)) - 1;
                const day = parseInt(daouCheckOut.useDate.substring(6, 8));
                orderDelivery.tradeAt = new Date(year, month, day);
              }
              // 사용처가 있으면 tradePlace에 설정
              if (daouCheckOut.useBranch) {
                orderDelivery.tradePlace = daouCheckOut.useBranch;
              }
            } else if (daouCheckOut.cpnStatus === '02') {
              orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
            }
          }
        }

        await this.orderDeliveryRepository.save(orderDelivery);
      } catch (e) {
        this.logger.log(`orderDeliveryId: ${orderDelivery.id} `);
        this.logger.error(e);
        this.logger.error(JSON.stringify(e));
      }
    }

    return;
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
            this.logger.warn(
              `[checkGalaxiaDaily] ${giftKind} 매칭되는 order_delivery 없음: barcode=${transaction.barcode}, ` +
                `barcodeLength=${transaction.barcode?.length}, barcodeHex=${Buffer.from(transaction.barcode ?? '').toString('hex')}`,
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

            const dedupSql = dedupQuery.getQuery();
            const dedupParams = dedupQuery.getParameters();
            this.logger.log(
              `[checkGalaxiaDaily] dedup SQL: ${dedupSql}, params: ${JSON.stringify(dedupParams)}`,
            );

            const existingLog = await dedupQuery.getOne();

            this.logger.log(
              `[checkGalaxiaDaily] dedup result for barcode=${transaction.barcode}: existingLog=${existingLog ? `id=${existingLog.id}, barcode=${existingLog.barcode}` : 'null'}`,
            );

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
        this.logger.log('[checkCulturelandDaily] 처리할 사용 내역이 없습니다.');
        return;
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
            notUsed: COUPON_STATUS_VALUES.NOT_USED,
          }).orWhere(
            new Brackets((qb2) => {
              qb2
                .where('orderDelivery.couponStatus = :used', {
                  used: COUPON_STATUS_VALUES.USED,
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
    const appDay = this.formatDateYMD(now);
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
      updateData.tradeAt = this.parseDateString(galaxiaOut.giftCertificate.usedDate);
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

  private formatDateYMD(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
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
}
