import { BadRequestException, Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
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
import { OrderReceiveSmsTemplate } from '../domain/order.receive.sms.template';
import { ISmsSend } from '../../sms/interface/sms.send';
import { defaultFromPhoneNumber } from '../../const';
import { OrderDeliveryEmailCouponStatus } from '../../delivery/interface/order.delivery.email.coupon.status';
import { Transactional } from 'typeorm-transactional';
import { ProductChoiceMappingEntity } from '../../entity/product.choice.mapping.entity';
import { IProductType } from '../../product/interface/product.type';
import { OrderReceiveChoiceDto } from '../api/dto/order.receive.choice.dto';
import { DeliveryCreateCouponImage } from '../../delivery/infra/delivery.create.coupon.image';
import { OrderReceiveChoiceSmsTemplate } from '../domain/order.receive.choice.sms.template';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { format } from 'date-fns';
import { normalizeLineBreaks } from '../../delivery/domain/email.delivery.template';
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
    private partnerCompanyExternService: PartnerCompanyExternService,
  ) {}

  async selectChoiceProduct(getBody: OrderReceiveSelectChoiceProductReqDto) {
    const orderDecrypt = this.cryptoCipher.decryptJson(getBody.encryptKey) as OrderEncryptKey;

    const orderDeliveryId = orderDecrypt.id ? orderDecrypt.id : orderDecrypt.orderDeliveryId;
    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 주문 정보입니다.');
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

    // 선택된 상품의 협력사 정보로 쿠폰 발급을 위해 임시로 product 교체
    const originalProduct = orderDelivery.orderProductMapping.product;
    orderDelivery.orderProductMapping.product = productChoiceMapping.product;

    await this.partnerCompanyExternService.issue(orderDelivery, null);

    // 원래 product로 복원 (초이스쿠폰 상품)
    orderDelivery.orderProductMapping.product = originalProduct;
    orderDelivery.choiceSelectProductId = productChoiceMapping.product.id;

    if (orderDelivery.barCode) {
      const productExpireDay = productChoiceMapping.product.expireDay || 0;
      const validityStartsNextDay = productChoiceMapping.product.partnerCompany?.validityStartsNextDay ?? true;
      const expireDay = validityStartsNextDay ? productExpireDay : productExpireDay - 1;

      const expireDate = expireDay ? dayjs().tz('Asia/Seoul').add(expireDay, 'day').format('YYYY. MM. DD') : null;

      const { path } = await DeliveryCreateCouponImage(
        productChoiceMapping.product.imagePath,
        productChoiceMapping.product.name,
        orderDelivery.barCode,
        productChoiceMapping.product.brand!.nameKorean,
        expireDate,
        orderDelivery.orderProductMapping.topImagePath,
        orderDelivery.orderProductMapping.midImagePath,
        orderDelivery.orderProductMapping.product.type,
      );
      orderDelivery.imagePath = path;
    }

    await this.orderDeliveryRepository.save(orderDelivery);

    return;
  }

  async alimTalk(getQuery: OrderReceiveAlimTalkReqDto): Promise<OrderReceiveAlimTalkResDto> {
    const orderDecrypt = this.cryptoCipher.decryptJson(getQuery.encryptKey) as OrderEncryptKey;

    // 테스트 발송인 경우 test_order_delivery 테이블에서 조회
    if (orderDecrypt.isTest) {
      return this.alimTalkForTest(orderDecrypt, getQuery.phoneNumber);
    }

    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('order.user', 'user')
      .where('orderDelivery.id = :id', { id: orderDecrypt.id })
      .getOne();

    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 주문 정보입니다.');
    }

    // deliveryTarget 복호화 후 비교
    let decryptedDeliveryTarget = orderDelivery.deliveryTarget;
    try {
      decryptedDeliveryTarget = this.cryptoCipher.decryptDeliveryTarget(orderDelivery.deliveryTarget);
    } catch (error) {
      throw new BadRequestException('전화번호 복호화에 실패했습니다.');
    }

    if (decryptedDeliveryTarget !== getQuery.phoneNumber) {
      throw new BadRequestException('전화번호가 일치하지 않습니다.');
    }

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
    if (orderDelivery.replaceCharacter1) {
      text = text.replace('{대치문자1}', orderDelivery.replaceCharacter1);
    }
    if (orderDelivery.replaceCharacter2) {
      text = text.replace('{대치문자2}', orderDelivery.replaceCharacter2);
    }
    if (orderDelivery.replaceCharacter3) {
      text = text.replace('{대치문자3}', orderDelivery.replaceCharacter3);
    }

    // 초이스쿠폰이고 상품을 선택한 경우, 선택된 상품의 정보 사용
    const displayProduct = selectedProductEntity || orderDelivery.orderProductMapping.product;
    const displayBrand = selectedProductEntity?.brand || orderDelivery.orderProductMapping.product.brand;

    return {
      topImagePath: orderDelivery.orderProductMapping.topImagePath,
      midImagePath: orderDelivery.orderProductMapping.midImagePath,
      fromPhoneNumber: orderDelivery.orderProductMapping.fromPhoneNumber!,
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
      userBusinessName: orderDelivery.orderProductMapping.order.user!.businessName,
      partnerCompany: displayProduct.partnerCompany?.type || null,
      validityStartsNextDay: displayProduct.partnerCompany?.validityStartsNextDay,
    };
  }

  /**
   * 테스트 발송용 알림톡 쿠폰 정보 조회
   */
  private async alimTalkForTest(
    orderDecrypt: OrderEncryptKey,
    phoneNumber: string,
  ): Promise<OrderReceiveAlimTalkResDto> {
    const testOrderDelivery = await this.testOrderDeliveryRepository
      .createQueryBuilder('testOrderDelivery')
      .innerJoinAndSelect('testOrderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('order.user', 'user')
      .where('testOrderDelivery.id = :id', { id: orderDecrypt.id })
      .getOne();

    if (!testOrderDelivery) {
      throw new BadRequestException('존재하지 않는 테스트 주문 정보입니다.');
    }

    // deliveryTarget 복호화 후 비교
    let decryptedDeliveryTarget = testOrderDelivery.deliveryTarget;
    try {
      decryptedDeliveryTarget = this.cryptoCipher.decryptDeliveryTarget(testOrderDelivery.deliveryTarget);
    } catch (error) {
      throw new BadRequestException('전화번호 복호화에 실패했습니다.');
    }

    if (decryptedDeliveryTarget !== phoneNumber) {
      throw new BadRequestException('전화번호가 일치하지 않습니다.');
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
    if (testOrderDelivery.replaceCharacter1) {
      text = text.replace('{대치문자1}', testOrderDelivery.replaceCharacter1);
    }
    if (testOrderDelivery.replaceCharacter2) {
      text = text.replace('{대치문자2}', testOrderDelivery.replaceCharacter2);
    }
    if (testOrderDelivery.replaceCharacter3) {
      text = text.replace('{대치문자3}', testOrderDelivery.replaceCharacter3);
    }

    const displayProduct = testOrderDelivery.orderProductMapping.product;
    const displayBrand = testOrderDelivery.orderProductMapping.product.brand;

    return {
      topImagePath: testOrderDelivery.orderProductMapping.topImagePath,
      midImagePath: testOrderDelivery.orderProductMapping.midImagePath,
      fromPhoneNumber: testOrderDelivery.orderProductMapping.fromPhoneNumber!,
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
      userBusinessName: testOrderDelivery.orderProductMapping.order.user!.businessName,
      partnerCompany: displayProduct.partnerCompany?.type || null,
      validityStartsNextDay: displayProduct.partnerCompany?.validityStartsNextDay,
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
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .where('orderDelivery.id = :id', { id: orderDecrypt.id })
      .getOne();
    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 주문 정보입니다.');
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

    if (emailSendHistory.expireAt < new Date()) {
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

    if (emailSendHistory.expireAt < new Date()) {
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
      }
    }

    const displayProduct = testOrderDelivery.orderProductMapping.product;

    return {
      productName: displayProduct.name,
      productImagePath: displayProduct.imagePath,
      sendEncryptKey: sendEncryptKey,
      type: testOrderDelivery.orderProductMapping.product.type,
      choiceProductList,
      selectChoiceProduct: null,
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

    // 이메일 쿠폰은 이 시점에 핀 발급 (초이스쿠폰 제외 - 초이스쿠폰은 상품 선택 시 발급)
    const isChoiceCoupon = orderDelivery.orderProductMapping.product.type === IProductType.CHOICE;
    if (!orderDelivery.barCode && !isChoiceCoupon) {
      try {
        await this.partnerCompanyExternService.issue(orderDelivery, null);
      } catch (e) {
        // 핀 발급 실패
        await this.orderDeliveryRepository.update(orderDelivery.id, {
          emailCouponStatus: OrderDeliveryEmailCouponStatus.FAIL,
          deliveryTarget: encryptedPhoneNumber,
        });
        throw new InternalServerErrorException('쿠폰 발급에 실패했습니다. 다시 시도해주세요.');
      }

      // 핀 발급 성공 후 쿠폰 이미지 생성
      if (orderDelivery.barCode) {
        const product = orderDelivery.orderProductMapping.product;
        const productExpireDay = product.expireDay || 0;
        const validityStartsNextDay = product.partnerCompany?.validityStartsNextDay ?? true;
        const expireDay = validityStartsNextDay ? productExpireDay : productExpireDay - 1;
        const expireDate = expireDay ? dayjs().tz('Asia/Seoul').add(expireDay, 'day').format('YYYY. MM. DD') : null;

        const { path } = await DeliveryCreateCouponImage(
          product.imagePath,
          product.name,
          orderDelivery.barCode,
          product.brand!.nameKorean,
          expireDate,
          orderDelivery.orderProductMapping.topImagePath,
          orderDelivery.orderProductMapping.midImagePath,
          product.type,
        );
        orderDelivery.imagePath = path;
        await this.orderDeliveryRepository.save(orderDelivery);
      }
    }

    const title = orderDelivery.orderProductMapping.sendTitle ?? '';
    const filePathList: string[] = [];
    if (orderDelivery.imagePath) {
      filePathList.push(orderDelivery.imagePath);
    }

    const text =
      orderDelivery.orderProductMapping.product.type !== IProductType.CHOICE
        ? OrderReceiveSmsTemplate(orderDelivery)
        : OrderReceiveChoiceSmsTemplate(orderDelivery);

    let status = IOrderDeliveryStatus.COMPLETE;
    let emailCouponStatus = OrderDeliveryEmailCouponStatus.SEND;
    try {
      await this.smsSend.send({
        msgType: 'M',
        to: getBody.phoneNumber,
        from: defaultFromPhoneNumber,
        subject: title,
        text: text,
        filePath: filePathList,
      });
    } catch (e) {
      status = IOrderDeliveryStatus.FAIL;
      // 핀은 발급됐지만 문자 발송 실패
      emailCouponStatus = OrderDeliveryEmailCouponStatus.PIN_ISSUED;
    }

    await this.orderDeliveryRepository.update(orderDelivery.id, {
      status: status,
      emailCouponStatus: emailCouponStatus,
      emailReceiverPhone: encryptedPhoneNumber,
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
      .where('testOrderDelivery.id = :id', { id: obj.orderDeliveryId })
      .getOne();

    if (!testOrderDelivery) {
      throw new BadRequestException('존재하지 않는 테스트 주문 정보입니다.');
    }

    // 이메일 발송 건인지 확인
    if (testOrderDelivery.deliveryMethod !== IOrderSendMethod.EMAIL) {
      throw new BadRequestException('이메일 발송 건이 아닙니다.');
    }

    // 테스트용 바코드 (999999)
    const testBarcode = '999999';

    // 테스트용 쿠폰 이미지 생성
    const product = testOrderDelivery.orderProductMapping.product;
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

    // 테스트용 SMS 템플릿 생성
    const text = `[테스트 발송]\n상품명: ${product.name}\n바코드: ${testBarcode}\n유효기간: ${expireDate || '없음'}`;

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
}
