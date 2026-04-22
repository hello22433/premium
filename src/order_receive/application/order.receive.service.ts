import { BadRequestException, Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { applyReplaceCharacters } from '../../common/utils/replace-characters.util';
import {
  OrderReceiveAlimTalkReqDto,
  OrderReceiveEmailReqDto,
  OrderReceiveSelectChoiceProductReqDto,
  OrderReceiveSendToMMsEmailReqDto,
} from '../api/order.receive.req.dto';
import { OrderReceiveAlimTalkResDto, OrderReceiveEmailResDto } from '../api/order.receive.res.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderEntity } from '../../entity/order.entity';
import { Repository } from 'typeorm';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { TestOrderDeliveryEntity } from '../../entity/test.order.delivery.entity';
import { OrderEncryptKey } from '../interface/order.encrypt.key';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { OrderSendEncryptKey } from '../interface/order.send.encrypt.key';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { ISmsSend } from '../../sms/interface/sms.send';
import { defaultFromPhoneNumber } from '../../const';
import { OrderDeliveryEmailCouponStatus } from '../../delivery/interface/order.delivery.email.coupon.status';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { Transactional } from 'typeorm-transactional';
import { ProductChoiceMappingEntity } from '../../entity/product.choice.mapping.entity';
import { IProductType } from '../../product/interface/product.type';
import { OrderReceiveChoiceDto } from '../api/dto/order.receive.choice.dto';
import { DeliveryCreateCouponImage } from '../../delivery/infra/delivery.create.coupon.image';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { DeliveryAlimTalk } from '../../delivery/interface/delivery.alim.talk';
import { AlimTalkTemplate } from '../../delivery/domain/alim.talk.template';
import { smsCouponInfoTemplate } from '../../delivery/domain/sms.coupon.info.template';
import { smsSsgTemplate } from '../../delivery/domain/sms.ssg.template';
import { IOrderType } from '../../order/interface/order.type';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { addDays, format, subDays } from 'date-fns';
import { normalizeLineBreaks } from '../../delivery/domain/email.delivery.template';
import { resolveExpireDays } from '../../common/utils/expire.util';
import { DateFormatStr } from '../../common/domain/date.format.str';

import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

@Injectable()
export class OrderReceiveService {
  constructor(
    private cryptoCipher: CryptoCipher,
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(TestOrderDeliveryEntity)
    private testOrderDeliveryRepository: Repository<TestOrderDeliveryEntity>,
    @InjectRepository(EmailSendHistoryEntity)
    private emailSendHistoryRepository: Repository<EmailSendHistoryEntity>,
    @InjectRepository(ProductChoiceMappingEntity)
    private productChoiceMappingRepository: Repository<ProductChoiceMappingEntity>,
    @Inject('ISmsSend')
    private smsSend: ISmsSend,
    @Inject('DeliveryAlimTalk')
    private deliveryAlimTalk: DeliveryAlimTalk,
    private partnerCompanyExternService: PartnerCompanyExternService,
    @InjectRepository(SsgEventEntity)
    private ssgEventRepository: Repository<SsgEventEntity>,
  ) {}

  private assertCouponNotDiscarded(orderDelivery: OrderDeliveryEntity): void {
    if (
      orderDelivery.couponStatus === OrderDeliveryCouponStatus.CANCEL ||
      orderDelivery.couponStatus === OrderDeliveryCouponStatus.REFUND_CANCEL
    ) {
      throw new BadRequestException('폐기된 쿠폰입니다.');
    }
  }

  private assertChoiceProductNotDeleted(orderDelivery: OrderDeliveryEntity): void {
    const product = orderDelivery.orderProductMapping.product;
    if (!product || (product.type === IProductType.CHOICE && product.deletedAt)) {
      throw new BadRequestException('이 쿠폰은 더 이상 제공되지 않습니다. 발송처에 문의해주세요.');
    }
  }

  async selectChoiceProduct(getBody: OrderReceiveSelectChoiceProductReqDto) {
    const orderDecrypt = this.cryptoCipher.decryptJson(getBody.encryptKey) as OrderEncryptKey & { emailSendHistoryId?: number; isTest?: boolean };

    // 테스트 발송인 경우 test_order_delivery에서 처리
    if (orderDecrypt.isTest) {
      return this.selectChoiceProductForTest(orderDecrypt, getBody.productId);
    }

    const orderDeliveryId = orderDecrypt.id ?? orderDecrypt.orderDeliveryId;
    const isEmailPath = !!orderDecrypt.emailSendHistoryId;

    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .leftJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .withDeleted()
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 주문 정보입니다.');
    }

    this.assertChoiceProductNotDeleted(orderDelivery);
    this.assertCouponNotDiscarded(orderDelivery);

    if (orderDelivery.expireAt) {
      const expireEnd = dayjs(orderDelivery.expireAt).tz('Asia/Seoul').endOf('day');
      if (dayjs().tz('Asia/Seoul').isAfter(expireEnd)) {
        throw new BadRequestException('유효기간이 만료된 쿠폰입니다.');
      }
    }

    const productChoiceMapping = await this.productChoiceMappingRepository
      .createQueryBuilder('productChoiceMapping')
      .innerJoinAndSelect('productChoiceMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .where('productChoiceMapping.productId = :productId', {
        productId: getBody.productId,
      })
      .getOne();
    if (!productChoiceMapping) {
      throw new InternalServerErrorException('choice product not exist');
    }

    // 이메일 경로: 상품 선택만 저장, PIN 발급은 sendToMMS()에서 전화번호 입력 후 처리
    // 알림톡/MMS 경로: 기존대로 즉시 PIN 발급 (이미 발급된 경우 건너뜀)
    if (!isEmailPath && !orderDelivery.barCode) {
      // SSG 행사 정보 조회
      let ssgEvent: SsgEventEntity | null = null;
      if (orderDelivery.orderProductMapping.order.type === IOrderType.SSG && orderDelivery.ssgEventId) {
        ssgEvent = await this.ssgEventRepository.findOne({
          where: { id: orderDelivery.ssgEventId },
        });
      }

      // 선택된 상품의 협력사 정보로 쿠폰 발급을 위해 임시로 product 교체
      const originalProduct = orderDelivery.orderProductMapping.product;
      orderDelivery.orderProductMapping.product = productChoiceMapping.product;

      await this.partnerCompanyExternService.issue(orderDelivery, ssgEvent);

      // 선택한 상품 기준 유효기간 재계산
      this.updateCouponExpiration(orderDelivery, productChoiceMapping.product);

      // 원래 product로 복원 (초이스쿠폰 상품)
      orderDelivery.orderProductMapping.product = originalProduct;

      // PIN 발급 성공 시 쿠폰 이미지 생성
      if (orderDelivery.barCode) {
        orderDelivery.imagePath = await this.createCouponImage(
          productChoiceMapping.product,
          orderDelivery,
        );
      }
    }

    orderDelivery.choiceSelectProductId = productChoiceMapping.product.id;

    await this.orderDeliveryRepository.save(orderDelivery);

    return;
  }

  /**
   * 테스트 발송용 초이스 쿠폰 상품 선택
   * test_order_delivery에서 조회하여 choiceSelectProductId만 저장
   */
  private async selectChoiceProductForTest(
    orderDecrypt: OrderEncryptKey & { emailSendHistoryId?: number; isTest?: boolean },
    productId: number,
  ) {
    const orderDeliveryId = orderDecrypt.id ?? orderDecrypt.orderDeliveryId;

    const testOrderDelivery = await this.testOrderDeliveryRepository
      .createQueryBuilder('testOrderDelivery')
      .innerJoinAndSelect('testOrderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .where('testOrderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!testOrderDelivery) {
      throw new BadRequestException('존재하지 않는 테스트 주문 정보입니다.');
    }

    const productChoiceMapping = await this.productChoiceMappingRepository
      .createQueryBuilder('productChoiceMapping')
      .innerJoinAndSelect('productChoiceMapping.product', 'product')
      .where('productChoiceMapping.productId = :productId', {
        productId: productId,
      })
      .getOne();
    if (!productChoiceMapping) {
      throw new InternalServerErrorException('choice product not exist');
    }

    testOrderDelivery.choiceSelectProductId = productChoiceMapping.product.id;
    await this.testOrderDeliveryRepository.save(testOrderDelivery);

    return;
  }

  async alimTalk(getQuery: OrderReceiveAlimTalkReqDto): Promise<OrderReceiveAlimTalkResDto> {
    const orderDecrypt = this.cryptoCipher.decryptJson(getQuery.encryptKey) as OrderEncryptKey;

    // 테스트 발송인 경우 test_order_delivery 테이블에서 조회
    if (orderDecrypt.isTest) {
      return this.alimTalkForTest(orderDecrypt);
    }

    // 이메일 경로(OrderSendEncryptKey)에서는 id가 없고 orderDeliveryId만 있음
    const orderDeliveryId = orderDecrypt.id ?? orderDecrypt.orderDeliveryId;

    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .leftJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .withDeleted()
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 주문 정보입니다.');
    }

    this.assertChoiceProductNotDeleted(orderDelivery);
    this.assertCouponNotDiscarded(orderDelivery);

    const choiceProductList: OrderReceiveChoiceDto[] = [];
    let selectChoiceProduct: OrderReceiveChoiceDto | null = null;
    let selectedProductEntity: any = null; // 선택된 상품의 전체 정보 (brand, memo 포함)

    // 초이스 쿠폰일 경우
    if (orderDelivery.orderProductMapping.product.type === IProductType.CHOICE) {
      const productChoiceMappingList = await this.productChoiceMappingRepository
        .createQueryBuilder('productChoiceMapping')
        .innerJoinAndSelect('productChoiceMapping.product', 'product')
        .innerJoinAndSelect('product.brand', 'brand')
        .where('productChoiceMapping.choiceProductId = :choiceProductId', {
          choiceProductId: orderDelivery.orderProductMapping.product.id,
        })
        .getMany();
      if (productChoiceMappingList.length === 0) {
        throw new InternalServerErrorException("choice product's choiceProductMapping is empty");
      }

      for (const productChoiceMapping of productChoiceMappingList) {
        choiceProductList.push({
          id: productChoiceMapping.product.id,
          name: productChoiceMapping.product.name,
          imagePath: productChoiceMapping.product.imagePath,
          price: productChoiceMapping.product.price,
          expireDay: productChoiceMapping.product.expireDay,
          brandNameKorean: productChoiceMapping.product.brand!.nameKorean,
          brandNameEnglish: productChoiceMapping.product.brand!.nameEnglish,
        });

        // 선택한 초이스 상품이 있을 시
        if (orderDelivery.choiceSelectProductId === productChoiceMapping.product.id) {
          selectChoiceProduct = {
            id: productChoiceMapping.product.id,
            name: productChoiceMapping.product.name,
            imagePath: productChoiceMapping.product.imagePath,
            price: productChoiceMapping.product.price,
            expireDay: productChoiceMapping.product.expireDay,
            brandNameKorean: productChoiceMapping.product.brand!.nameKorean,
            brandNameEnglish: productChoiceMapping.product.brand!.nameEnglish,
          };
          // 선택된 상품의 전체 정보 저장 (brand, memo 포함)
          selectedProductEntity = productChoiceMapping.product;
        }
      }
    }

    let text = orderDelivery.orderProductMapping.sendContent ?? '';

    if (orderDelivery.orderProductMapping.sendTailText) {
      text += orderDelivery.orderProductMapping.sendTailText;
    }
    text = applyReplaceCharacters(text, orderDelivery);

    // 초이스쿠폰이고 상품을 선택한 경우, 선택된 상품의 정보 사용
    const displayProduct = selectedProductEntity || orderDelivery.orderProductMapping.product;
    const displayBrand = selectedProductEntity?.brand || orderDelivery.orderProductMapping.product.brand;

    const order = orderDelivery.orderProductMapping.order;
    const userBusinessName = order.clientUser?.company?.businessName ?? order.user!.company?.businessName ?? '';

    return {
      topImagePath: orderDelivery.orderProductMapping.topImagePath,
      midImagePath: orderDelivery.orderProductMapping.midImagePath,
      fromPhoneNumber: orderDelivery.orderProductMapping.fromPhoneNumber!,
      sendTitle: orderDelivery.orderProductMapping.sendTitle ?? '',
      productName: displayProduct.name,
      productImagePath: displayProduct.imagePath,
      brandName: displayBrand!.nameKorean,
      barCode: orderDelivery.barCode!,
      personalCode: orderDelivery.personalCode,
      couponStatus: orderDelivery.couponStatus,
      context: text,
      type: orderDelivery.orderProductMapping.product.type,
      choiceProductList,
      selectChoiceProduct,
      memo: displayProduct.memo ? normalizeLineBreaks(displayProduct.memo, '<br>') : '',
      sendRequestAt: format(orderDelivery.sendRequestAt, DateFormatStr),
      expireDay: displayProduct.expireDay,
      brandKoreanName: displayBrand!.nameKorean === '신세계' ? '이마트' : displayBrand!.nameKorean,
      userBusinessName,
      partnerCompany: displayProduct.partnerCompany?.type || null,
      validityStartsNextDay: displayProduct.partnerCompany?.validityStartsNextDay,
      expireAt: orderDelivery.expireAt ? dayjs(orderDelivery.expireAt).format('YYYY-MM-DD') : null,
    };
  }

  /**
   * 테스트 발송용 알림톡 쿠폰 정보 조회
   */
  private async alimTalkForTest(
    orderDecrypt: OrderEncryptKey,
  ): Promise<OrderReceiveAlimTalkResDto> {
    const orderDeliveryId = orderDecrypt.id ?? orderDecrypt.orderDeliveryId;

    const testOrderDelivery = await this.testOrderDeliveryRepository
      .createQueryBuilder('testOrderDelivery')
      .withDeleted()
      .innerJoinAndSelect('testOrderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .where('testOrderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!testOrderDelivery) {
      throw new BadRequestException('존재하지 않는 테스트 주문 정보입니다.');
    }

    const choiceProductList: OrderReceiveChoiceDto[] = [];

    // 초이스 쿠폰일 경우 목록 조회 (테스트에서는 선택 불가)
    if (testOrderDelivery.orderProductMapping.product.type === IProductType.CHOICE) {
      const productChoiceMappingList = await this.productChoiceMappingRepository
        .createQueryBuilder('productChoiceMapping')
        .innerJoinAndSelect('productChoiceMapping.product', 'product')
        .innerJoinAndSelect('product.brand', 'brand')
        .where('productChoiceMapping.choiceProductId = :choiceProductId', {
          choiceProductId: testOrderDelivery.orderProductMapping.product.id,
        })
        .getMany();

      for (const productChoiceMapping of productChoiceMappingList) {
        choiceProductList.push({
          id: productChoiceMapping.product.id,
          name: productChoiceMapping.product.name,
          imagePath: productChoiceMapping.product.imagePath,
          price: productChoiceMapping.product.price,
          expireDay: productChoiceMapping.product.expireDay,
          brandNameKorean: productChoiceMapping.product.brand!.nameKorean,
          brandNameEnglish: productChoiceMapping.product.brand!.nameEnglish,
        });
      }
    }

    let text = testOrderDelivery.orderProductMapping.sendContent ?? '';

    if (testOrderDelivery.orderProductMapping.sendTailText) {
      text += testOrderDelivery.orderProductMapping.sendTailText;
    }
    text = applyReplaceCharacters(text, testOrderDelivery);

    const displayProduct = testOrderDelivery.orderProductMapping.product;
    const displayBrand = testOrderDelivery.orderProductMapping.product.brand;

    const order = testOrderDelivery.orderProductMapping.order;
    const userBusinessName = order.clientUser?.company?.businessName ?? order.user!.company?.businessName ?? '';

    return {
      topImagePath: testOrderDelivery.orderProductMapping.topImagePath,
      midImagePath: testOrderDelivery.orderProductMapping.midImagePath,
      fromPhoneNumber: testOrderDelivery.orderProductMapping.fromPhoneNumber!,
      sendTitle: testOrderDelivery.orderProductMapping.sendTitle ?? '',
      productName: displayProduct.name,
      productImagePath: displayProduct.imagePath,
      brandName: displayBrand!.nameKorean,
      barCode: testOrderDelivery.barCode!,
      personalCode: testOrderDelivery.personalCode,
      couponStatus: testOrderDelivery.couponStatus,
      context: text,
      type: testOrderDelivery.orderProductMapping.product.type,
      choiceProductList,
      selectChoiceProduct: null, // 테스트 발송은 초이스 쿠폰 선택 불가
      memo: displayProduct.memo ? normalizeLineBreaks(displayProduct.memo, '<br>') : '',
      sendRequestAt: format(testOrderDelivery.sendRequestAt, DateFormatStr),
      expireDay: displayProduct.expireDay,
      brandKoreanName: displayBrand!.nameKorean === '신세계' ? '이마트' : displayBrand!.nameKorean,
      userBusinessName,
      partnerCompany: displayProduct.partnerCompany?.type || null,
      validityStartsNextDay: displayProduct.partnerCompany?.validityStartsNextDay,
      expireAt: null, // 테스트 발송은 expireAt 미설정
    };
  }

  async email(getQuery: OrderReceiveEmailReqDto): Promise<OrderReceiveEmailResDto> {
    const orderDecrypt = this.cryptoCipher.decryptJson(getQuery.encryptKey) as OrderEncryptKey;

    // 테스트 발송인 경우 test_order_delivery에서 조회
    if (orderDecrypt.isTest) {
      return this.emailForTest(orderDecrypt, getQuery.code);
    }

    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .leftJoinAndSelect('orderProductMapping.product', 'product')
      .withDeleted()
      .where('orderDelivery.id = :id', { id: orderDecrypt.id })
      .getOne();
    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 주문 정보입니다.');
    }

    this.assertChoiceProductNotDeleted(orderDelivery);
    this.assertCouponNotDiscarded(orderDelivery);

    if (!orderDecrypt.emailHistoryId) {
      throw new BadRequestException('올바른 요청이 아닙니다.');
    }
    const emailSendHistory = await this.emailSendHistoryRepository.findOne({
      where: {
        id: orderDecrypt.emailHistoryId,
      },
    });

    if (!emailSendHistory) {
      throw new BadRequestException('이메일 전송 데이터가 없습니다.');
    }

    if (emailSendHistory.expireAt && emailSendHistory.expireAt < new Date()) {
      throw new BadRequestException('만료된 이메일 인증 코드입니다.');
    }

    if (emailSendHistory.code !== getQuery.code) {
      throw new BadRequestException('코드가 일치하지 않습니다.');
    }

    emailSendHistory.isCertified = true;
    await this.emailSendHistoryRepository.save(emailSendHistory);

    const sendEncryptKey = this.cryptoCipher.encryptJson({
      emailSendHistoryId: emailSendHistory.id,
      orderDeliveryId: orderDelivery.id,
    } as OrderSendEncryptKey);

    const choiceProductList: OrderReceiveChoiceDto[] = [];
    let selectChoiceProduct: OrderReceiveChoiceDto | null = null;
    let selectedProductEntity: any = null; // 선택된 상품의 전체 정보

    // 초이스 쿠폰일 경우
    if (orderDelivery.orderProductMapping.product.type === IProductType.CHOICE) {
      const productChoiceMappingList = await this.productChoiceMappingRepository
        .createQueryBuilder('productChoiceMapping')
        .innerJoinAndSelect('productChoiceMapping.product', 'product')
        .innerJoinAndSelect('product.brand', 'brand')
        .where('productChoiceMapping.choiceProductId = :choiceProductId', {
          choiceProductId: orderDelivery.orderProductMapping.product.id,
        })
        .getMany();
      if (productChoiceMappingList.length === 0) {
        throw new InternalServerErrorException("choice product's choiceProductMapping is empty");
      }

      for (const productChoiceMapping of productChoiceMappingList) {
        choiceProductList.push({
          id: productChoiceMapping.product.id,
          name: productChoiceMapping.product.name,
          imagePath: productChoiceMapping.product.imagePath,
          price: productChoiceMapping.product.price,
          expireDay: productChoiceMapping.product.expireDay,
          brandNameKorean: productChoiceMapping.product.brand!.nameKorean,
          brandNameEnglish: productChoiceMapping.product.brand!.nameEnglish,
        });

        // 선택한 초이스 상품이 있을 시
        if (orderDelivery.choiceSelectProductId === productChoiceMapping.product.id) {
          selectChoiceProduct = {
            id: productChoiceMapping.product.id,
            name: productChoiceMapping.product.name,
            imagePath: productChoiceMapping.product.imagePath,
            price: productChoiceMapping.product.price,
            expireDay: productChoiceMapping.product.expireDay,
            brandNameKorean: productChoiceMapping.product.brand!.nameKorean,
            brandNameEnglish: productChoiceMapping.product.brand!.nameEnglish,
          };
          // 선택된 상품의 전체 정보 저장
          selectedProductEntity = productChoiceMapping.product;
        }
      }
    }

    // 초이스쿠폰이고 상품을 선택한 경우, 선택된 상품의 정보 사용
    const displayProduct = selectedProductEntity || orderDelivery.orderProductMapping.product;

    return {
      productName: displayProduct.name,
      productImagePath: displayProduct.imagePath,
      sendEncryptKey: sendEncryptKey,
      type: orderDelivery.orderProductMapping.product.type,
      choiceProductList,
      selectChoiceProduct,
    };
  }

  /**
   * 테스트 발송용 이메일 인증 처리
   */
  private async emailForTest(
    orderDecrypt: OrderEncryptKey,
    code: string,
  ): Promise<OrderReceiveEmailResDto> {
    const testOrderDelivery = await this.testOrderDeliveryRepository
      .createQueryBuilder('testOrderDelivery')
      .innerJoinAndSelect('testOrderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .where('testOrderDelivery.id = :id', { id: orderDecrypt.id })
      .getOne();

    if (!testOrderDelivery) {
      throw new BadRequestException('존재하지 않는 테스트 주문 정보입니다.');
    }

    if (!orderDecrypt.emailHistoryId) {
      throw new BadRequestException('올바른 요청이 아닙니다.');
    }

    const emailSendHistory = await this.emailSendHistoryRepository.findOne({
      where: {
        id: orderDecrypt.emailHistoryId,
      },
    });

    if (!emailSendHistory) {
      throw new BadRequestException('이메일 전송 데이터가 없습니다.');
    }

    if (emailSendHistory.expireAt && emailSendHistory.expireAt < new Date()) {
      throw new BadRequestException('만료된 이메일 인증 코드입니다.');
    }

    if (emailSendHistory.code !== code) {
      throw new BadRequestException('코드가 일치하지 않습니다.');
    }

    emailSendHistory.isCertified = true;
    await this.emailSendHistoryRepository.save(emailSendHistory);

    // 테스트 발송용 sendEncryptKey (isTest 플래그 포함)
    const sendEncryptKey = this.cryptoCipher.encryptJson({
      emailSendHistoryId: emailSendHistory.id,
      orderDeliveryId: testOrderDelivery.id,
      isTest: true,
    } as OrderSendEncryptKey);

    const choiceProductList: OrderReceiveChoiceDto[] = [];
    let selectChoiceProduct: OrderReceiveChoiceDto | null = null;

    // 초이스 쿠폰일 경우 목록 조회
    if (testOrderDelivery.orderProductMapping.product.type === IProductType.CHOICE) {
      const productChoiceMappingList = await this.productChoiceMappingRepository
        .createQueryBuilder('productChoiceMapping')
        .innerJoinAndSelect('productChoiceMapping.product', 'product')
        .innerJoinAndSelect('product.brand', 'brand')
        .where('productChoiceMapping.choiceProductId = :choiceProductId', {
          choiceProductId: testOrderDelivery.orderProductMapping.product.id,
        })
        .getMany();

      for (const productChoiceMapping of productChoiceMappingList) {
        choiceProductList.push({
          id: productChoiceMapping.product.id,
          name: productChoiceMapping.product.name,
          imagePath: productChoiceMapping.product.imagePath,
          price: productChoiceMapping.product.price,
          expireDay: productChoiceMapping.product.expireDay,
          brandNameKorean: productChoiceMapping.product.brand!.nameKorean,
          brandNameEnglish: productChoiceMapping.product.brand!.nameEnglish,
        });

        // 선택한 초이스 상품이 있을 시
        if (testOrderDelivery.choiceSelectProductId === productChoiceMapping.product.id) {
          selectChoiceProduct = {
            id: productChoiceMapping.product.id,
            name: productChoiceMapping.product.name,
            imagePath: productChoiceMapping.product.imagePath,
            price: productChoiceMapping.product.price,
            expireDay: productChoiceMapping.product.expireDay,
            brandNameKorean: productChoiceMapping.product.brand!.nameKorean,
            brandNameEnglish: productChoiceMapping.product.brand!.nameEnglish,
          };
        }
      }
    }

    const displayProduct = testOrderDelivery.orderProductMapping.product;

    return {
      productName: displayProduct.name,
      productImagePath: displayProduct.imagePath,
      sendEncryptKey: sendEncryptKey,
      type: testOrderDelivery.orderProductMapping.product.type,
      choiceProductList,
      selectChoiceProduct,
    };
  }

  @Transactional()
  async sendToMMS(getBody: OrderReceiveSendToMMsEmailReqDto) {
    let obj: OrderSendEncryptKey;
    try {
      obj = this.cryptoCipher.decryptJson(getBody.sendEncryptKey) as OrderSendEncryptKey;
    } catch (e) {
      throw new BadRequestException('올바른 sendEncryptKey 값 이 아닙니다');
    }

    // 테스트 발송인 경우 별도 처리
    if (obj.isTest) {
      return this.sendToMMSForTest(obj, getBody.phoneNumber);
    }

    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .where('orderDelivery.id = :id', { id: obj.orderDeliveryId })
      .getOne();
    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 주문 정보입니다.');
    }

    if (!obj.emailSendHistoryId) {
      throw new BadRequestException('올바른 요청이 아닙니다.');
    }

    // 이메일 발송 건인지 확인
    if (orderDelivery.deliveryMethod !== IOrderSendMethod.EMAIL) {
      throw new BadRequestException('이메일 발송 건이 아닙니다.');
    }

    if (orderDelivery.emailCouponStatus === OrderDeliveryEmailCouponStatus.SEND) {
      throw new BadRequestException('이미 전송한 쿠폰입니다.');
    }

    this.assertCouponNotDiscarded(orderDelivery);

    const emailSendHistory = await this.emailSendHistoryRepository.findOne({
      where: {
        id: obj.emailSendHistoryId,
      },
    });

    if (!emailSendHistory) {
      throw new BadRequestException('이메일 전송 이력이 존재하지 않습니다.');
    }

    if (!emailSendHistory.isCertified) {
      throw new BadRequestException('인증받지 않은 key입니다.');
    }

    // 핸드폰 번호 암호화 저장
    const encryptedPhoneNumber = this.cryptoCipher.encryptDeliveryTarget(getBody.phoneNumber);

    // 이메일 쿠폰은 이 시점에 핀 발급 (초이스쿠폰 포함 - 전화번호 입력 후 발급)
    const isChoiceCoupon = orderDelivery.orderProductMapping.product.type === IProductType.CHOICE;
    if (!orderDelivery.barCode) {
      // 초이스쿠폰: 선택된 상품의 협력사 정보로 PIN 발급
      let issueProduct = orderDelivery.orderProductMapping.product;

      if (isChoiceCoupon) {
        if (!orderDelivery.choiceSelectProduct) {
          throw new BadRequestException('상품을 먼저 선택해주세요.');
        }
        const choiceProductMapping = await this.productChoiceMappingRepository
          .createQueryBuilder('productChoiceMapping')
          .innerJoinAndSelect('productChoiceMapping.product', 'product')
          .innerJoinAndSelect('product.brand', 'brand')
          .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
          .where('productChoiceMapping.productId = :productId', {
            productId: orderDelivery.choiceSelectProduct.id,
          })
          .getOne();
        if (!choiceProductMapping) {
          throw new InternalServerErrorException('선택된 초이스 상품 정보를 찾을 수 없습니다.');
        }
        issueProduct = choiceProductMapping.product;
      }

      // SSG 행사 정보 조회 (배치 발송 경로와 동일)
      let ssgEvent: SsgEventEntity | null = null;
      if (orderDelivery.orderProductMapping.order.type === IOrderType.SSG && orderDelivery.ssgEventId) {
        ssgEvent = await this.ssgEventRepository.findOne({
          where: { id: orderDelivery.ssgEventId },
        });
      }

      // PIN 발급 (초이스쿠폰은 선택된 상품으로 임시 교체 후 발급)
      const originalProduct = orderDelivery.orderProductMapping.product;
      orderDelivery.orderProductMapping.product = issueProduct;
      try {
        await this.partnerCompanyExternService.issue(orderDelivery, ssgEvent);
      } catch (e) {
        orderDelivery.orderProductMapping.product = originalProduct;
        await this.orderDeliveryRepository.update(orderDelivery.id, {
          emailCouponStatus: OrderDeliveryEmailCouponStatus.FAIL,
          deliveryTarget: encryptedPhoneNumber,
        });
        throw new InternalServerErrorException('쿠폰 발급에 실패했습니다. 다시 시도해주세요.');
      }
      orderDelivery.orderProductMapping.product = originalProduct;

      // PIN 발급 성공 시 유효기간 재계산 + 쿠폰 이미지 생성
      if (orderDelivery.barCode) {
        this.updateCouponExpiration(orderDelivery, issueProduct);
        orderDelivery.imagePath = await this.createCouponImage(issueProduct, orderDelivery);
        await this.orderDeliveryRepository.save(orderDelivery);
      }
    }

    const title = orderDelivery.orderProductMapping.sendTitle ?? '';
    const filePathList: string[] = [];
    if (orderDelivery.imagePath) {
      filePathList.push(orderDelivery.imagePath);
    }

    let status = IOrderDeliveryStatus.COMPLETE;
    let emailCouponStatus = OrderDeliveryEmailCouponStatus.SEND;

    try {
      // 1차: 알림톡 발송 시도 (기존 등록 템플릿 사용)
      const alimTalkText = AlimTalkTemplate(orderDelivery);
      const { report } = await this.deliveryAlimTalk.send({
        to: getBody.phoneNumber,
        text: alimTalkText,
        encryptKey: getBody.sendEncryptKey,
      });

      if (report.code !== 'A000') {
        throw new Error('AlimTalk Send Error');
      }
    } catch (alimTalkError) {
      // 2차: 알림톡 실패 시 MMS 폴백 (배치 문자 발송 패턴과 동일)
      let mmsText = orderDelivery.orderProductMapping.sendContent ?? '';

      if (orderDelivery.orderProductMapping.product.memo
          && orderDelivery.orderProductMapping.order.type !== IOrderType.SSG) {
        mmsText += `\n\n${orderDelivery.orderProductMapping.product.memo}`;
      }

      const sendTailText = orderDelivery.orderProductMapping.sendTailText;
      if (sendTailText) {
        mmsText += `\n\n${sendTailText}`;
      }

      mmsText = applyReplaceCharacters(mmsText, orderDelivery);

      const orderType = orderDelivery.orderProductMapping.order.type;
      const productType = orderDelivery.orderProductMapping.product.type;

      if (orderType === IOrderType.SSG) {
        mmsText += smsSsgTemplate(orderDelivery);
      }

      if (orderType !== IOrderType.SSG && productType !== IProductType.CHOICE && orderDelivery.barCode) {
        mmsText = smsCouponInfoTemplate(orderDelivery) + '\n\n' + mmsText;
      }

      try {
        await this.smsSend.send({
          msgType: 'M',
          to: getBody.phoneNumber,
          from: defaultFromPhoneNumber,
          subject: title,
          text: mmsText,
          filePath: filePathList,
        });
      } catch (mmsError) {
        // 알림톡, MMS 모두 실패
        status = IOrderDeliveryStatus.FAIL;
        emailCouponStatus = OrderDeliveryEmailCouponStatus.PIN_ISSUED;
      }
    }

    await this.orderDeliveryRepository.update(orderDelivery.id, {
      status: status,
      emailCouponStatus: emailCouponStatus,
      emailReceiverPhone: encryptedPhoneNumber,
      ...(status === IOrderDeliveryStatus.FAIL ? { failedAt: new Date() } : {}),
    });

    return;
  }

  /**
   * 테스트 이메일 발송 건의 MMS 전송 (테스트용)
   * 실제 핀 발급 없이 테스트 핀(999999)으로 MMS 발송
   */
  private async sendToMMSForTest(obj: OrderSendEncryptKey, phoneNumber: string) {
    const testOrderDelivery = await this.testOrderDeliveryRepository
      .createQueryBuilder('testOrderDelivery')
      .innerJoinAndSelect('testOrderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('testOrderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.brand', 'choiceSelectBrand')
      .where('testOrderDelivery.id = :id', { id: obj.orderDeliveryId })
      .getOne();

    if (!testOrderDelivery) {
      throw new BadRequestException('존재하지 않는 테스트 주문 정보입니다.');
    }

    // 이메일 발송 건인지 확인
    if (testOrderDelivery.deliveryMethod !== IOrderSendMethod.EMAIL) {
      throw new BadRequestException('이메일 발송 건이 아닙니다.');
    }

    // 초이스 쿠폰인 경우 선택된 상품 확인
    const isChoiceCoupon = testOrderDelivery.orderProductMapping.product.type === IProductType.CHOICE;
    if (isChoiceCoupon && !testOrderDelivery.choiceSelectProductId) {
      throw new BadRequestException('상품을 먼저 선택해주세요.');
    }

    // 테스트용 바코드 (999999)
    const testBarcode = '999999';

    // 초이스 쿠폰이면 선택된 상품, 아니면 기본 상품 사용
    const product = (isChoiceCoupon && testOrderDelivery.choiceSelectProduct)
      ? testOrderDelivery.choiceSelectProduct
      : testOrderDelivery.orderProductMapping.product;
    const productExpireDay = product.expireDay || 0;
    const expireDate = productExpireDay ? dayjs().tz('Asia/Seoul').add(productExpireDay, 'day').format('YYYY. MM. DD') : null;

    const { path } = await DeliveryCreateCouponImage(
      product.imagePath,
      product.name,
      testBarcode,
      product.brand!.nameKorean,
      expireDate,
      testOrderDelivery.orderProductMapping.topImagePath,
      testOrderDelivery.orderProductMapping.midImagePath,
      product.type,
    );

    const title = testOrderDelivery.orderProductMapping.sendTitle ?? '';
    const filePathList: string[] = [path];

    // 테스트용 MMS 텍스트 생성 (sendContent 기반, 배치 문자 발송 패턴과 동일)
    let text = testOrderDelivery.orderProductMapping.sendContent ?? '';
    if (product.memo) {
      text += `\n\n${product.memo}`;
    }
    const sendTailText = testOrderDelivery.orderProductMapping.sendTailText;
    if (sendTailText) {
      text += `\n\n${sendTailText}`;
    }
    text = applyReplaceCharacters(text, testOrderDelivery);
    text = `[테스트 발송]\n▷상품명: ${product.name}\n▷쿠폰번호: ${testBarcode}\n▷유효기간: ${expireDate || '없음'}\n\n${text}`;

    try {
      await this.smsSend.send({
        msgType: 'M',
        to: phoneNumber,
        from: defaultFromPhoneNumber,
        subject: title,
        text: text,
        filePath: filePathList,
      });
    } catch (e) {
      throw new InternalServerErrorException('테스트 MMS 발송에 실패했습니다.');
    }

    return;
  }

  /**
   * 실제 쿠폰 발급 시점 기준 유효기간 재계산 (초이스 선택 / 이메일 전화번호 입력)
   * SSG는 issue() 내부에서 expireAt/encourageAt을 설정하므로 couponIssuedAt만 기록
   */
  private updateCouponExpiration(
    orderDelivery: OrderDeliveryEntity,
    selectedProduct: { galaxiaDuration?: number | null; expireDay: number; partnerCompany?: { validityStartsNextDay?: boolean | null } | null },
  ): void {
    const now = new Date();
    orderDelivery.couponIssuedAt = now;

    const isSsg = orderDelivery.orderProductMapping.order.type === IOrderType.SSG;
    if (!isSsg) {
      const expireDays = resolveExpireDays(
        orderDelivery.orderProductMapping.galaxiaDuration ?? selectedProduct.galaxiaDuration,
        selectedProduct.expireDay,
        selectedProduct.partnerCompany?.validityStartsNextDay,
      );
      orderDelivery.expireAt = addDays(now, expireDays);

      const encourageDay = orderDelivery.orderProductMapping.encourageDay;
      if (encourageDay) {
        orderDelivery.encourageAt = subDays(orderDelivery.expireAt, encourageDay);
      }
    }
  }

  /**
   * 쿠폰 이미지 생성 - 주어진 product 정보로 만료일 계산 후 이미지 생성
   */
  private async createCouponImage(product: any, orderDelivery: OrderDeliveryEntity): Promise<string> {
    let expireDate: string | null = null;
    if (orderDelivery.expireAt) {
      expireDate = dayjs(orderDelivery.expireAt).tz('Asia/Seoul').format('YYYY. MM. DD');
    } else {
      const productExpireDay = product.expireDay || 0;
      const validityStartsNextDay = product.partnerCompany?.validityStartsNextDay ?? true;
      const expireDay = validityStartsNextDay ? productExpireDay : productExpireDay - 1;
      expireDate = expireDay ? dayjs().tz('Asia/Seoul').add(expireDay, 'day').format('YYYY. MM. DD') : null;
    }

    const { path } = await DeliveryCreateCouponImage(
      product.imagePath,
      product.name,
      orderDelivery.barCode!,
      product.brand!.nameKorean,
      expireDate,
      orderDelivery.orderProductMapping.topImagePath,
      orderDelivery.orderProductMapping.midImagePath,
      orderDelivery.orderProductMapping.product.type,
    );

    return path;
  }
}
