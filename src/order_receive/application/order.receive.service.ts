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
import { OrderEncryptKey } from '../interface/order.encrypt.key';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { OrderSendEncryptKey } from '../interface/order.send.encrypt.key';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
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

@Injectable()
export class OrderReceiveService {
  constructor(
    private cryptoCipher: CryptoCipher,
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
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
      .where('productChoiceMapping.productId = :productId', {
        productId: getBody.productId,
      })
      .getOne();
    if (!productChoiceMapping) {
      throw new InternalServerErrorException('choice product not exist');
    }

    await this.partnerCompanyExternService.issue(orderDelivery, null);
    orderDelivery.choiceSelectProductId = productChoiceMapping.product.id;

    if (orderDelivery.barCode) {
      const { path } = await DeliveryCreateCouponImage(
        productChoiceMapping.product.imagePath,
        productChoiceMapping.product.name,
        orderDelivery.barCode,
        productChoiceMapping.product.brand!.nameKorean,
        productChoiceMapping.product.expireDay,
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
        }
      }
    }

    let text = orderDelivery.orderProductMapping.order.sendContent;

    if (orderDelivery.orderProductMapping.order.sendTailText) {
      text += orderDelivery.orderProductMapping.order.sendTailText;
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

    return {
      topImagePath: orderDelivery.orderProductMapping.topImagePath,
      midImagePath: orderDelivery.orderProductMapping.midImagePath,
      fromPhoneNumber: orderDelivery.orderProductMapping.order.fromPhoneNumber!,
      productName: orderDelivery.orderProductMapping.product.name,
      productImagePath: orderDelivery.orderProductMapping.product.imagePath,
      brandName: orderDelivery.orderProductMapping.product.brand!.nameKorean,
      barCode: orderDelivery.barCode!,
      personalCode: orderDelivery.personalCode,
      couponStatus: orderDelivery.couponStatus,
      context: text,
      type: orderDelivery.orderProductMapping.product.type,
      choiceProductList,
      selectChoiceProduct,
      memo: orderDelivery.orderProductMapping.product.memo
        ? normalizeLineBreaks(orderDelivery.orderProductMapping.product.memo, '<br>')
        : '',
      sendRequestAt: format(orderDelivery.sendRequestAt, DateFormatStr),
      expireDay: orderDelivery.orderProductMapping.product.expireDay,
      brandKoreanName:
        orderDelivery.orderProductMapping.product.brand!.nameKorean === '신세계'
          ? '이마트'
          : orderDelivery.orderProductMapping.product.brand!.nameKorean,
      userBusinessName: orderDelivery.orderProductMapping.order.user!.businessName,
      partnerCompany: orderDelivery.orderProductMapping.product.partnerCompany?.type || null,
    };
  }

  async email(getQuery: OrderReceiveEmailReqDto): Promise<OrderReceiveEmailResDto> {
    const orderDecrypt = this.cryptoCipher.decryptJson(getQuery.encryptKey) as OrderEncryptKey;

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
        }
      }
    }

    return {
      productName: orderDelivery.orderProductMapping.product.name,
      productImagePath: orderDelivery.orderProductMapping.product.imagePath,
      sendEncryptKey: sendEncryptKey,
      type: orderDelivery.orderProductMapping.product.type,
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

    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .where('orderDelivery.id = :id', { id: obj.orderDeliveryId })
      .getOne();
    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 주문 정보입니다.');
    }

    if (!obj.emailSendHistoryId) {
      throw new BadRequestException('올바른 요청이 아닙니다.');
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

    const title = orderDelivery.orderProductMapping.order.sendTitle;
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
      emailCouponStatus = OrderDeliveryEmailCouponStatus.NOT_SEND;
    } finally {
      await this.orderDeliveryRepository.update(orderDelivery.id, {
        status: status,
        emailCouponStatus: emailCouponStatus,
      });
    }

    return;
  }
}
