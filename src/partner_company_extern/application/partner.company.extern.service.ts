import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
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
import { orderBarcodeGenerate } from '../../order/domain/order.code.generate';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { OrderEntity } from '../../entity/order.entity';
import { SsgTransactionId } from '../domain/ssg.transaction.id';
import { defaultFromPhoneNumber, ssgIssueUserName } from '../../const';
import { smsSsgTemplate } from '../../delivery/domain/sms.ssg.template';
import { addDays, format, subDays } from 'date-fns';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { CancelCouponResDto } from '../api/CancelCouponResDto';
import { CryptoCipher } from '../../common/infra/crypto.cipher';

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
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(PartnerCompanyExternHistoryEntity)
    private partnerCompanyExternHistoryRepository: Repository<PartnerCompanyExternHistoryEntity>,
    private cryptoCipher: CryptoCipher,
  ) {}

  private logger = new Logger('PARTNER_COMPANY_EXTERN');

  @Transactional({ propagation: Propagation.REQUIRED })
  async issue(orderDelivery: OrderDeliveryEntity, ssgEvent: SsgEventEntity | null) {
    const type = orderDelivery.orderProductMapping!.product.partnerCompany!.type;

    // deliveryTarget 복호화
    let decryptedDeliveryTarget = orderDelivery.deliveryTarget;
    if (orderDelivery.deliveryTarget) {
      try {
        decryptedDeliveryTarget = this.cryptoCipher.decryptDeliveryTarget(orderDelivery.deliveryTarget);
      } catch (error) {
        this.logger.error(`Failed to decrypt deliveryTarget for orderDelivery ${orderDelivery.id}: ${error}`);
        // 복호화 실패 시 원본 데이터 사용
        decryptedDeliveryTarget = orderDelivery.deliveryTarget;
      }
    }

    let context = '';
    let isSuccess = true;
    if (!orderDelivery.transactionId) {
      throw new Error('transaction id not exist');
    }

    try {
      if (!type || orderDelivery.orderProductMapping.product.type === 'SELF') {
        orderDelivery.barCode = orderBarcodeGenerate();
        return;
      }

      // 1.1.1 갤럭시아 쿠폰 발급
      // 표준연동발행규격서 v.1.6.8_갤럭시아머니트리.pdf
      if (type === 'GALAXIA') {
        const giftKind = orderDelivery.orderProductMapping.product.name.includes('(백화점)') ? 'dept' : 'cpn';
        const galaxiaOut = await this.galaxia.issue({
          transactionId: orderDelivery.transactionId,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode,
          fromPhoneNumber: decryptedDeliveryTarget,
          giftKind: giftKind,
        });
        context = JSON.stringify(galaxiaOut);
        orderDelivery.barCode = galaxiaOut.giftCertificate.barcode ?? null;
        orderDelivery.couponNum = galaxiaOut.transactionId;
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
        orderDelivery.barCode = giftielOut.CouponList[0].CouponNum;
      }

      // 1.1.4 giftshow 쿠폰 발급
      // 기프티쇼_매체_연동규격서_v1.9.1.2.pdf
      if (type === 'GIFT_SHOW') {
        const giftShowOut = await this.giftiShow.issue({
          transactionId: orderDelivery.transactionId,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode,
        });
        context = JSON.stringify(giftShowOut);
        orderDelivery.barCode = giftShowOut.response.value[0].pin_no[0];
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
        orderDelivery.couponNum = cultureLandOut.CertNo;
      }

      // 1.1.6 신세계 상품권 발행
      if (type === 'SSG') {
        if (!ssgEvent) {
          throw new InternalServerErrorException('ssg event 가 존재하지 않습니다.');
        }
        const order = await this.orderRepository.findOne({
          where: {
            id: orderDelivery.orderProductMapping.orderId,
          },
        });

        if (!order) {
          throw new InternalServerErrorException('order not exist');
        }

        const { barCode, personalCode } = this.ssgIssue.generateSsgIssue();

        orderDelivery.barCode = barCode;
        orderDelivery.personalCode = personalCode;
        orderDelivery.ssgTransactionId = SsgTransactionId.makeSsgTrade();
        orderDelivery.expireAt = addDays(
          orderDelivery.sendRequestAt,
          orderDelivery.orderProductMapping.product.expireDay - 1,
        );
        if (order.encourageDay) {
          orderDelivery.encourageAt = subDays(orderDelivery.expireAt, order.encourageDay);
        }
        let text = order.sendContent;

        if (order.sendTailText) {
          text += order.sendTailText;
        }
        if (orderDelivery.replaceCharacter1) {
          text = text.replace('{대치문자1}', orderDelivery.replaceCharacter1);
        }
        if (orderDelivery.replaceCharacter2) {
          text = text.replace('{대치문자2}', orderDelivery.replaceCharacter2);
        }
        if (orderDelivery.replaceCharacter3) {
          text = text.replace('{대치문자3}', orderDelivery.replaceCharacter3);
        }

        const textForSsg = text + smsSsgTemplate(orderDelivery);

        const response = await this.ssgIssue.issue({
          eventNo: ssgEvent.no,
          eventSeq: ssgEvent.order,
          eventKey: ssgEvent.code,
          vno: orderDelivery.personalCode,
          pinNo: orderDelivery.barCode,
          userName: ssgIssueUserName,
          userAmount: '' + orderDelivery.orderProductMapping.product.price,
          msgContent: textForSsg,
          trId: orderDelivery.ssgTransactionId,
          callBack:
            order.fromPhoneNumber === '' || !order.fromPhoneNumber ? defaultFromPhoneNumber : order.fromPhoneNumber,
        });
        context = JSON.stringify(response);
      }

      this.logger.log(orderDelivery.barCode);
      if (!orderDelivery.barCode) {
        throw new Error('barCode not exist');
      }

      // return;
    } catch (e) {
      this.logger.log(JSON.stringify(e));
      this.logger.log(e);
      context = JSON.stringify(e);
      isSuccess = false;
      orderDelivery.status = IOrderDeliveryStatus.FAIL;
    } finally {
      if (type !== null) {
        // 호출 이력 저장(성공/실패 구분) → 동일한 “REQUIRES_NEW” 트랜잭션에서 커밋됨
        await this.partnerCompanyExternHistoryRepository.insert({
          context,
          isSuccess,
          type: type!,
        });
      }
    }
  }

  @Transactional({ propagation: Propagation.REQUIRED })
  async cancel(orderDelivery: OrderDeliveryEntity): Promise<CancelCouponResDto> {
    const type = orderDelivery.orderProductMapping!.product.partnerCompany!.type;

    try {
      // 1.1.1 갤럭시아 쿠폰 발급
      // 표준연동발행규격서 v.1.6.8_갤럭시아머니트리.pdf
      if (type === 'GALAXIA') {
        const giftKind = orderDelivery.orderProductMapping.product.name.includes('(백화점)') ? 'dept' : 'cpn';
        await this.galaxia.cancel({
          transactionId: orderDelivery.transactionId!,
          sendRequestAt: +format(orderDelivery.sendRequestAt, 'yyyyMMdd'),
          giftKind,
          trId: orderDelivery.couponNum!,
        });
      }

      // 1.1.2 GSMBIZ 쿠폰 발급
      // GSM쿠폰_전문사양서_고객사_표준V3.4_20200529.pdf
      if (type === 'GS_M_BIZ') {
        await this.gsmbiz.cancel({
          transactionId: orderDelivery.transactionId!,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode,
          barCode: orderDelivery.barCode!,
        });
      }

      // 1.1.3 Giftiel 쿠폰 발급
      // giftiel(기프티엘)_공통_판매사_연동가이드_v2.1.0.0_20210409.pdf
      if (type === 'GIFTIEL') {
        await this.giftiel.cancel({
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode,
          barCode: orderDelivery.barCode!,
        });
      }

      // 1.1.4 giftshow 쿠폰 발급
      // 기프티쇼_매체_연동규격서_v1.9.1.2.pdf
      if (type === 'GIFT_SHOW') {
        await this.giftiShow.cancel({
          transactionId: orderDelivery.transactionId!,
        });
      }

      // 1.1.5 컬쳐랜드 쿠폰 발급
      // 컬쳐랜드상품권(모바일문화상품권)_구매_연동가이드_V3.0.pdf
      if (type === 'CULTURELAND') {
        await this.culture.cancel({
          barCode: orderDelivery.barCode!,
          expireDay: orderDelivery.orderProductMapping.product.expireDay,
        });
      }

      // 1.1.6 신세계 및 없는 type 은 타입만 수정
      orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;

      return {
        code: '',
        message: '폐기 완료',
      } as CancelCouponResDto;
    } catch (e) {
      this.logger.log(JSON.stringify(e));
      this.logger.log(e);
      return {
        code: '',
        message: '잠시 후 다시 시도해 주세요.',
      } as CancelCouponResDto;
    }
  }

  async refreshCouponStatus(orderDelivery: OrderDeliveryEntity): Promise<OrderDeliveryEntity> {
    const partnerType = orderDelivery.orderProductMapping.product.partnerCompany?.type;

    if (!partnerType) {
      throw new Error('partnerCompany type is null');
    }

    switch (partnerType) {
      // 1. GALAXIA
      case 'GALAXIA': {
        const baseProduct = orderDelivery.choiceSelectProduct ?? orderDelivery.orderProductMapping.product;

        const giftKind: 'dept' | 'cpn' = baseProduct.name.includes('(백화점)') ? 'dept' : 'cpn';

        const { giftCertificate } = await this.galaxia.check({
          giftKind,
          paramValue: orderDelivery.couponNum!,
        });

        orderDelivery.couponStatus = giftCertificate.isUsed
          ? OrderDeliveryCouponStatus.USED
          : OrderDeliveryCouponStatus.NOT_USED;
        orderDelivery.tradeAt = giftCertificate.usedDate ? new Date(giftCertificate.usedDate) : null;
        orderDelivery.galaxiaBalance = Number(giftCertificate.balance);
        break;
      }

      // 2. GS_M_BIZ
      case 'GS_M_BIZ': {
        const partnerCompanyCode =
          orderDelivery.choiceSelectProduct?.partnerCompanyCode ??
          orderDelivery.orderProductMapping.product.partnerCompanyCode!;

        const { couponInfo } = await this.gsmbiz.check({
          transactionId: orderDelivery.transactionId!,
          partnerCompanyCode,
          barCode: orderDelivery.barCode!,
        });

        orderDelivery.couponStatus =
          couponInfo.STATE === '10' ? OrderDeliveryCouponStatus.USED : OrderDeliveryCouponStatus.NOT_USED;
        orderDelivery.tradeAt = couponInfo.USE_DT ? new Date(couponInfo.USE_DT) : null;
        break;
      }

      // 3. GIFTIEL
      case 'GIFTIEL': {
        const partnerCompanyCode =
          orderDelivery.choiceSelectProduct?.partnerCompanyCode ??
          orderDelivery.orderProductMapping.product.partnerCompanyCode!;

        const giftielOut = await this.giftiel.check({
          partnerCompanyCode,
          barCode: orderDelivery.barCode!,
        });

        orderDelivery.couponStatus =
          giftielOut.UseYn === 'Y' ? OrderDeliveryCouponStatus.USED : OrderDeliveryCouponStatus.NOT_USED;
        orderDelivery.tradeAt = giftielOut.UseDate ? new Date(giftielOut.UseDate) : null;
        break;
      }

      // 4. GIFT_SHOW
      case 'GIFT_SHOW': {
        const giftiShowOut = await this.giftiShow.check({
          transactionId: orderDelivery.transactionId!,
        });

        orderDelivery.couponStatus =
          giftiShowOut.StatusCode === '0' ? OrderDeliveryCouponStatus.NOT_USED : OrderDeliveryCouponStatus.USED;
        break;
      }

      // 5. CULTURELAND
      case 'CULTURELAND': {
        const expireDay =
          orderDelivery.choiceSelectProduct?.expireDay ?? orderDelivery.orderProductMapping.product.expireDay;

        const cultureLandOut = await this.culture.check({
          scrachNo: orderDelivery.barCode!,
          certNo: orderDelivery.couponNum!, // 상품권 관리번호
          requestAt: orderDelivery.sendRequestAt!,
          expireDay,
        });

        orderDelivery.couponStatus =
          cultureLandOut.CancelPossibility === 'N'
            ? OrderDeliveryCouponStatus.USED
            : OrderDeliveryCouponStatus.NOT_USED;
        break;
      }

      // SSG
      case 'SSG': {
        if (!orderDelivery.ssgEvent) {
          throw new Error('ssgEvent not loaded on orderDelivery');
        }
        if (!orderDelivery.personalCode) {
          throw new Error('personalCode is null');
        }

        const ssgOut = await this.ssgIssue.check({
          eventNo: orderDelivery.ssgEvent.no,
          eventSeq: orderDelivery.ssgEvent.order,
          vno: orderDelivery.personalCode,
        });

        const resultCd = ssgOut.response.value[0].resultCd[0];
        orderDelivery.couponStatus =
          resultCd === '0400' ? OrderDeliveryCouponStatus.USED : OrderDeliveryCouponStatus.NOT_USED;
        break;
      }

      // 기타
      default:
        throw new Error(`Unsupported partnerCompany type: ${partnerType}`);
    }

    // 저장
    return this.orderDeliveryRepository.save(orderDelivery);
  }
}
