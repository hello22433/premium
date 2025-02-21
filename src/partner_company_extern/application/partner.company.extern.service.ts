import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { Repository } from 'typeorm';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { ICulture } from '../interface/culture';
import { IGalaxia } from '../interface/galaxia';
import { IGsmbiz } from '../interface/gsmbiz';
import { IGiftiel } from '../interface/giftiel';
import { IGiftiShow } from '../interface/giftishow';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { ISsgIssue } from '../interface/ssg.issue';
import { Propagation, Transactional } from 'typeorm-transactional';

@Injectable()
export class PartnerCompanyExternService {
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
    @InjectRepository(PartnerCompanyExternHistoryEntity)
    private partnerCompanyExternHistoryRepository: Repository<PartnerCompanyExternHistoryEntity>,
  ) {}

  @Transactional({ propagation: Propagation.REQUIRED })
  async issue(orderDelivery: OrderDeliveryEntity) {
    const type = orderDelivery.orderProductMapping!.product.partnerCompany!.type;

    let context = '';
    let isSuccess = true;
    if (!orderDelivery.transactionId) {
      throw new Error('transaction id not exist');
    }

    try {
      // 1.1.1 갤럭시아 쿠폰 발급
      // 표준연동발행규격서 v.1.6.8_갤럭시아머니트리.pdf
      if (type === 'GALAXIA') {
        const giftKind = orderDelivery.orderProductMapping.product.name.includes('(백화점)') ? 'dept' : 'cpn';
        const galaxiaOut = await this.galaxia.issue({
          transactionId: orderDelivery.transactionId,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode,
          fromPhoneNumber: orderDelivery.deliveryTarget,
          giftKind: giftKind,
        });
        context = JSON.stringify(galaxiaOut);
        orderDelivery.barCode = galaxiaOut.giftCertificate.barcode;
      }

      // 1.1.2 GSMBIZ 쿠폰 발급
      // GSM쿠폰_전문사양서_고객사_표준V3.4_20200529.pdf
      if (type === 'GS_M_BIZ') {
        const gsMBizOut = await this.gsmbiz.issue({
          transactionId: orderDelivery.transactionId,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode,
        });
        context = JSON.stringify(gsMBizOut);
        orderDelivery.barCode = gsMBizOut.couponInfo.barCode;
      }

      // 1.1.3 Giftiel 쿠폰 발급
      // giftiel(기프티엘)_공통_판매사_연동가이드_v2.1.0.0_20210409.pdf
      if (type === 'GIFTIEL') {
        const giftielOut = await this.giftiel.issue({
          transactionId: orderDelivery.transactionId,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode,
        });

        context = JSON.stringify(giftielOut);
        orderDelivery.barCode = giftielOut.CouponList[0].PinNumber;
      }

      // 1.1.4 giftshow 쿠폰 발급
      // 기프티쇼_매체_연동규격서_v1.9.1.2.pdf
      if (type === 'GIFT_SHOW') {
        const giftShowOut = await this.giftiShow.issue({
          transactionId: orderDelivery.transactionId,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode,
        });
        context = JSON.stringify(giftShowOut);
        orderDelivery.barCode = giftShowOut.value.pin_no;
      }

      // 1.1.5 컬쳐랜드 쿠폰 발급
      // 컬쳐랜드상품권(모바일문화상품권)_구매_연동가이드_V3.0.pdf
      if (type === 'CULTURELAND') {
        const cultureLandOut = await this.culture.issue({
          transactionId: orderDelivery.transactionId,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode,
          expireDay: orderDelivery.orderProductMapping.product.expireDay,
          price: orderDelivery.orderProductMapping.product.price,
        });
        context = JSON.stringify(cultureLandOut);
        orderDelivery.barCode = cultureLandOut.ScrachNo;
      }

      // 1.1.6 신세계 상품권 발행
      if (type === 'SSG') {
        const ssgBardCode = await this.ssgIssue.issue('8', 7);
        context = ssgBardCode;
        orderDelivery.barCode = ssgBardCode;
      }
      return;
    } catch (e) {
      context = JSON.stringify(e);
      isSuccess = false;
      orderDelivery.status = IOrderDeliveryStatus.FAIL;
    } finally {
      this.partnerCompanyExternHistoryRepository.insert({
        context,
        isSuccess,
        type: type!,
      });
    }
  }
}
