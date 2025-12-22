import { Inject, Injectable, Logger } from '@nestjs/common';
import { IGalaxia } from '../interface/galaxia';
import { IGsmbiz } from '../interface/gsmbiz';
import { IGiftiel } from '../interface/giftiel';
import { IGiftiShow } from '../interface/giftishow';
import { ICulture } from '../interface/culture';
import { ISsgIssue } from '../interface/ssg.issue';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { Repository } from 'typeorm';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';

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
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
  ) {}

  private logger = new Logger('PARTNER_COMPANY_EXTERN_BATCH');

  async check() {
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
        if (type === 'CULTURELAND') {
          let expireDay = orderDelivery.orderProductMapping.product.expireDay;
          if (orderDelivery.choiceSelectProduct) {
            expireDay = orderDelivery.choiceSelectProduct.expireDay!;
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
}
