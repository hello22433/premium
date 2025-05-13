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
            giftKind: giftKind,
            trId: orderDelivery.couponNum!,
          });
          orderDelivery.couponStatus = galaxiaOut.giftCertificate.isUsed
            ? OrderDeliveryCouponStatus.USED
            : OrderDeliveryCouponStatus.NOT_USED;
          orderDelivery.tradeAt = galaxiaOut.giftCertificate.usedDate
            ? new Date(galaxiaOut.giftCertificate.usedDate)
            : null;
          orderDelivery.galaxiaBalance = +galaxiaOut.giftCertificate.balance;
        }

        // 1.1.2 GSMBIZ 쿠폰 발급
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

        // 1.1.3 Giftiel 쿠폰 발급
        // giftiel(기프티엘)_공통_판매사_연동가이드_v2.1.0.0_20210409.pdf
        if (type === 'GIFTIEL') {
          const giftielOut = await this.giftiel.check({
            partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
            barCode: orderDelivery.barCode!,
          });

          orderDelivery.couponStatus =
            giftielOut.UseYn === 'Y' ? OrderDeliveryCouponStatus.USED : orderDelivery.couponStatus;
          orderDelivery.tradeAt = giftielOut.UseDate ? new Date(giftielOut.UseDate) : null;
        }

        // 1.1.4 giftshow 쿠폰 발급
        // 기프티쇼_매체_연동규격서_v1.9.1.2.pdf
        if (type === 'GIFT_SHOW') {
          const giftShowOut = await this.giftiShow.check({
            transactionId: orderDelivery.transactionId!,
          });
          orderDelivery.couponStatus =
            giftShowOut.response.result[0].StatusCode[0] != '0'
              ? OrderDeliveryCouponStatus.USED
              : OrderDeliveryCouponStatus.NOT_USED;
        }

        // 1.1.5 컬쳐랜드 쿠폰 발급
        // 컬쳐랜드상품권(모바일문화상품권)_구매_연동가이드_V3.0.pdf
        if (type === 'CULTURELAND') {
          let expireDay = orderDelivery.orderProductMapping.product.expireDay;
          if (orderDelivery.choiceSelectProduct) {
            expireDay = orderDelivery.choiceSelectProduct.expireDay!;
          }
          const cultureLandOut = await this.culture.check({
            barCode: orderDelivery.barCode!,
            couponNum: orderDelivery.couponNum!,
            requestAt: orderDelivery.sendRequestAt!,
            expireDay: expireDay,
          });
          orderDelivery.couponStatus =
            cultureLandOut.CancelPossibility != 'Y'
              ? OrderDeliveryCouponStatus.USED
              : OrderDeliveryCouponStatus.NOT_USED;
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
}
