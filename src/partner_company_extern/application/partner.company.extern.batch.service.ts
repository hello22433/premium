import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IGalaxia } from '../interface/galaxia';
import { IGsmbiz } from '../interface/gsmbiz';
import { IGiftiel } from '../interface/giftiel';
import { IGiftiShow } from '../interface/giftishow';
import { ICulture } from '../interface/culture';
import { ISsgIssue } from '../interface/ssg.issue';
import { IDaou } from '../interface/daou';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { Repository } from 'typeorm';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import {
  PartnerCompanyType,
  ApiCallResult,
  BatchStatistics,
  PartnerCompanyGroup,
} from './partner.company.extern.batch.types';

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
    private configService: ConfigService,
  ) {}

  private logger = new Logger('PARTNER_COMPANY_EXTERN_BATCH');

  // ===== 설정값 =====
  private get pageSize(): number {
    return this.configService.get<number>('BATCH_PAGE_SIZE', 100);
  }

  private get apiTimeoutMs(): number {
    return this.configService.get<number>('BATCH_API_TIMEOUT_MS', 30000);
  }

  private get retryCount(): number {
    return this.configService.get<number>('BATCH_RETRY_COUNT', 1);
  }

  private getConcurrencyLimit(type: PartnerCompanyType): number {
    const key = `BATCH_CONCURRENCY_${type}`;
    return this.configService.get<number>(key, 5);
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
          hasMore = false;
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
      .andWhere('orderDelivery.status LIKE :status', { status: 'COMPLETE%' })
      .andWhere('orderDelivery.couponStatus = :couponStatus', { couponStatus: 'NOT_USED' })
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
    if (type === 'GALAXIA') {
      let giftKind: 'dept' | 'cpn' = orderDelivery.orderProductMapping.product.name.includes('(백화점)')
        ? 'dept'
        : 'cpn';

      if (orderDelivery.choiceSelectProduct) {
        giftKind = orderDelivery.choiceSelectProduct.name.includes('(백화점)') ? 'dept' : 'cpn';
      }

      const galaxiaOut = await this.galaxia.check({
        giftKind,
        paramValue: orderDelivery.couponNum!,
      });

      result.couponStatus = galaxiaOut.giftCertificate.isUsed
        ? OrderDeliveryCouponStatus.USED
        : OrderDeliveryCouponStatus.NOT_USED;
      result.tradeAt = galaxiaOut.giftCertificate.usedDate ? new Date(galaxiaOut.giftCertificate.usedDate) : null;
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
            result.tradeAt = this.parseDateTime(exchDtm);
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
            result.tradeAt = this.parseDate(daouCheckOut.useDate);
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
  private parseDateTime(dtm: string): Date {
    // YYYYMMDDHHmmss 형식
    return new Date(
      parseInt(dtm.substring(0, 4)),
      parseInt(dtm.substring(4, 6)) - 1,
      parseInt(dtm.substring(6, 8)),
      parseInt(dtm.substring(8, 10)),
      parseInt(dtm.substring(10, 12)),
      parseInt(dtm.substring(12, 14)),
    );
  }

  private parseDate(date: string): Date {
    // YYYYMMDD 형식
    return new Date(
      parseInt(date.substring(0, 4)),
      parseInt(date.substring(4, 6)) - 1,
      parseInt(date.substring(6, 8)),
    );
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

      // 각 거래 항목에 대해 order_delivery 매칭 및 tradePlace 업데이트
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

          // tradePlace 업데이트
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
}
