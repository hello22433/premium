import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { applyReplaceCharacters } from '../../common/utils/replace-characters.util';
import {
  CustomerServiceCouponRefreshReqDto,
  CustomerServiceDiscardReqDto,
  CustomerServiceExcelDownloadReqDto,
  CustomerServiceGetDetailListReqDto,
  CustomerServiceGetDetailReqDto,
  CustomerServiceGetListReqDto,
  CustomerServiceHistoryReqDto,
  CustomerServicePinStatusModifyReqDto,
  CustomerServicePinStatusRefreshReqDto,
  CustomerServiceRefundReqDto,
  CustomerServiceReSendReqDto,
  CustomerServiceStatusListReqDto,
  CustomerServiceUnmaskedDeliveryTargetReqDto,
} from '../api/customer.service.req.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderEntity } from '../../entity/order.entity';
import { DataSource, IsNull, QueryRunner, Repository } from 'typeorm';
import { CustomerServiceGetListResDto } from '../api/customer.service.res.dto';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { CustomerServiceViewDto } from '../api/dto/customer.service.view.dto';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { CustomerServiceDetailViewDto } from '../api/dto/customer.service.detail.view.dto';
import { CustomerServiceDlvryDetailViewDto } from '../api/dto/customer.service.dlvry.detail.view.dto';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { DeliveryBatchService } from '../../delivery/application/delivery.batch.service';
import { IOrderType } from '../../order/interface/order.type';
import { smsSsgShortTemplate } from '../../delivery/domain/sms.ssg.template';
import { OrderDeliveryCouponStatus, couponStatusToKorean } from '../../delivery/interface/order.delivery.coupon.status';
import { ILoginUserInfo } from 'src/auth/interface/login.user';
import { OrderHistoryEntity } from 'src/entity/order.history.entity';
import { User } from 'src/auth/api/user.decorator';
import { GemteckMsgQueueEntity } from 'src/entity/gemtek/msg.queue.entity';
import { SmsGemtekSend } from 'src/sms/infra/sms.gemtek.send';
import { MaskingUtil } from 'src/common/utils/masking.util';
import { CryptoCipher } from 'src/common/infra/crypto.cipher';
import { PhoneUtil } from 'src/common/utils/phone.util';
import { OrderDeliveryRefundStatusEnum } from '../../delivery/interface/order.delivery.refund.status.enum';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { IProductType } from '../../product/interface/product.type';
import { OrderEncryptKey } from '../../order_receive/interface/order.encrypt.key';
import { ActivityLogService } from 'src/activity_log/application/activity.log.service';
import { ActivityLogActionType } from 'src/activity_log/interface/activity.log.action.type';
import { ActivityLogResult } from 'src/activity_log/interface/activity.log.result';
import { UserEntity } from 'src/entity/user.entity';
import { UserCompanyEntity } from 'src/entity/user.company.entity';
import { OrderFeeCalculator, applyCardSurcharge } from '../../order/domain/order.fee.calculator';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';

const dayjs = require('dayjs');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(timezone);

@Injectable()
export class CustomerServiceService {
  private static readonly DELIVERY_METHOD_DISPLAY: Record<string, string> = {
    [IOrderSendMethod.ALIM_TALK]: '알림톡',
    [IOrderSendMethod.MMS]: 'MMS',
    [IOrderSendMethod.EMAIL]: '이메일',
  };

  constructor(
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    private partnerCompanyExternService: PartnerCompanyExternService,
    private deliveryBatchService: DeliveryBatchService,
    @InjectRepository(OrderHistoryEntity)
    private readonly orderHistoryRepository: Repository<OrderHistoryEntity>,
    @InjectRepository(GemteckMsgQueueEntity, 'gemtek_sms')
    private gemteckMsgQueueRepository: Repository<GemteckMsgQueueEntity>,
    private smsGemtekSend: SmsGemtekSend,
    private readonly cryptoCipher: CryptoCipher,
    private readonly activityLogService: ActivityLogService,
    private readonly configService: ConfigService,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(UserCompanyEntity)
    private readonly userCompanyRepository: Repository<UserCompanyEntity>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 폐기 시 정산금액(할인가) 기준으로 예치금/여신 복구
   * - FAIL/FAIL_SMS: 이미 refundForFail()로 환불됨 → 스킵
   * - isSettleBalance=true: balance 복구 (company/account mode 분기)
   * - isSettleBalance=false: allSettleAmount 차감 (여신 복구)
   */
  private async restoreBalanceOnDiscard(
    orderDelivery: OrderDeliveryEntity,
    operatorUser: ILoginUserInfo,
    queryRunner: QueryRunner,
  ): Promise<void> {
    const mapping = orderDelivery.orderProductMapping;
    const order = mapping.order;

    // 이중 복구 방지: FAIL/FAIL_SMS는 refundForFail()에서 이미 환불됨
    if (
      orderDelivery.status === IOrderDeliveryStatus.FAIL ||
      orderDelivery.status === IOrderDeliveryStatus.FAIL_SMS
    ) {
      return;
    }

    // 정산금액 계산 (calculateSettlementPrice 패턴 - delivery.batch.service.ts:182-188)
    let price = mapping.product.price;
    if (mapping.fee !== null && mapping.priceAdjustment) {
      price = OrderFeeCalculator({ fee: mapping.fee, priceAdjustment: mapping.priceAdjustment, price });
    }
    const restoreAmount = applyCardSurcharge(price, order.cardSurchargeApplied);

    // 과금 대상 사용자 (대행주문 시 clientUserId)
    const billingUserId = order.clientUserId ?? order.userId;
    const user = await queryRunner.manager.findOne(UserEntity, {
      where: { id: billingUserId },
      relations: ['company'],
    });
    if (!user) return;

    let beforeBalance: number;
    let afterBalance: number;

    if (order.isSettleBalance) {
      // 선정산 or 정산완료 → balance 복구
      const company = user.company;
      if (company?.balanceManagementType === 'COMPANY') {
        beforeBalance = company.balance;
        company.balance += restoreAmount;
        afterBalance = company.balance;
        await queryRunner.manager.save(UserCompanyEntity, company);
      } else {
        beforeBalance = user.balance;
        user.balance += restoreAmount;
        afterBalance = user.balance;
        await queryRunner.manager.save(UserEntity, user);
      }
    } else {
      // 후정산 미정산 → allSettleAmount 차감 (여신 복구)
      beforeBalance = user.allSettleAmount;
      user.allSettleAmount -= restoreAmount;
      afterBalance = user.allSettleAmount;
      await queryRunner.manager.save(UserEntity, user);
    }

    // ActivityLog 기록 (DISCARD_RESTORE)
    await this.activityLogService.createLog({
      userId: operatorUser.id,
      userEmail: operatorUser.email,
      method: 'POST',
      requestUrl: '/customer-service/discard-restore',
      actionType: ActivityLogActionType.DISCARD_RESTORE,
      ipAddress: '',
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime: 0,
      requestParams: {
        targetUserId: billingUserId,
        targetUserEmail: user.email,
        targetBusinessName: user.company?.businessName ?? '',
        targetCompanyId: user.company?.id ?? null,
        orderDeliveryId: orderDelivery.id,
        orderId: order.id,
        restoreAmount,
        isSettleBalance: order.isSettleBalance,
        beforeBalance,
        afterBalance,
        memo: `폐기복구/ ${restoreAmount}원/ orderDelivery:${orderDelivery.id}`,
      },
    });
  }

  async getList(getQuery: CustomerServiceGetListReqDto): Promise<CustomerServiceGetListResDto> {
    const {
      orderType,
      startAt,
      endAt,
      userCompanyId,
      couponStatus,
      orderNumber,
      productName,
      productCode,
      deliveryTarget,
      sendTitle,
      partnerCompanyId,
      keyword,
      eventName,
      page,
      take,
    } = getQuery;

    // order_delivery 기반으로 조회하도록 변경
    let queryBuilder = this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.partnerCompany', 'choicePartnerCompany')
      .leftJoinAndMapOne('order.user', 'user', 'user', 'user.id = order.user_id AND user.deleted_at IS NULL')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndMapOne('order.clientUser', 'user', 'clientUser', 'clientUser.id = order.client_user_id AND clientUser.deleted_at IS NULL')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .andWhere('orderDelivery.status IN (:...deliveryStatus)', { deliveryStatus: ['COMPLETE', 'COMPLETE_SMS'] })
      .andWhere('orderDelivery.deletedAt IS NULL');

    if (orderType === 'GENERAL') {
      queryBuilder.andWhere('product.type IN (:...types)', { types: ['GENERAL', 'CHOICE'] });
    }

    if (orderType === 'SSG') {
      queryBuilder.andWhere('product.type = :type', { type: 'SSG' });
    }

    // 고객사 (userCompanyId)
    if (userCompanyId) {
      queryBuilder.andWhere('user.companyId = :userCompanyId', { userCompanyId });
    }

    // 통합검색 (주문번호, 상품명, 상품코드, MMS제목, 수신정보를 OR 조건으로 검색)
    if (keyword) {
      const normalizedKeyword = PhoneUtil.normalizeDeliveryTarget(keyword);
      const encryptedKeyword = this.cryptoCipher.encryptDeliveryTarget(normalizedKeyword);
      queryBuilder.andWhere(
        `(CAST(order.id AS CHAR) LIKE :keyword
          OR product.name LIKE :keyword
          OR product.code LIKE :keyword
          OR orderProductMapping.sendTitle LIKE :keyword
          OR order.eventName LIKE :keyword
          OR orderDelivery.deliveryTarget = :encryptedKeyword)`,
        { keyword: `%${keyword}%`, encryptedKeyword },
      );
    }

    // 이벤트명 (부분검색)
    if (eventName) {
      queryBuilder.andWhere('order.eventName LIKE :eventName', { eventName: `%${eventName}%` });
    }

    // 주문번호 (부분검색)
    if (orderNumber) {
      queryBuilder.andWhere('CAST(order.id AS CHAR) LIKE :orderNumber', { orderNumber: `%${orderNumber}%` });
    }

    // 핀상태
    if (couponStatus) {
      queryBuilder.andWhere('orderDelivery.couponStatus = :couponStatus', { couponStatus });
    }

    // 상품명 (부분검색)
    if (productName) {
      queryBuilder.andWhere('product.name LIKE :productName', { productName: `%${productName}%` });
    }

    // 상품코드 (부분검색)
    if (productCode) {
      queryBuilder.andWhere('product.code LIKE :productCode', { productCode: `%${productCode}%` });
    }

    // 수신정보 (전문검색 - 암호화하여 비교)
    if (deliveryTarget) {
      const normalizedTarget = PhoneUtil.normalizeDeliveryTarget(deliveryTarget);
      const encryptedTarget = this.cryptoCipher.encryptDeliveryTarget(normalizedTarget);
      queryBuilder.andWhere('orderDelivery.deliveryTarget = :deliveryTarget', { deliveryTarget: encryptedTarget });
    }

    // MMS제목 (부분검색)
    if (sendTitle) {
      queryBuilder.andWhere('orderProductMapping.sendTitle LIKE :sendTitle', { sendTitle: `%${sendTitle}%` });
    }

    // 협력사
    if (partnerCompanyId) {
      queryBuilder.andWhere('product.partnerCompanyId = :partnerCompanyId', { partnerCompanyId });
    }

    // 날짜 조건을 실제 발송일(actualSendAt) 기준으로 변경
    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'orderDelivery', 'actualSendAt', startAt, endAt);

    // 총 금액 계산 (페이징 적용 전 전체 조건에 대해)
    const sumResult = await queryBuilder
      .clone()
      .select('SUM(COALESCE(choiceSelectProduct.price, product.price))', 'totalPrice')
      .getRawOne();
    const totalPrice = Number(sumResult?.totalPrice) || 0;

    const skip = (page - 1) * take;
    queryBuilder.take(take).skip(skip);
    queryBuilder.orderBy('orderDelivery.actualSendAt', 'DESC');
    const [orderDeliveryList, totalCount] = await queryBuilder.getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const result: CustomerServiceViewDto[] = [];
    for (const orderDelivery of orderDeliveryList) {
      const order = orderDelivery.orderProductMapping.order;
      const product = orderDelivery.orderProductMapping.product;

      // deliveryTarget 복호화 및 마스킹 처리
      const decryptedDeliveryTarget = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget);
      const maskedDeliveryTarget = decryptedDeliveryTarget ? MaskingUtil.maskDeliveryTarget(decryptedDeliveryTarget) : null;

      // emailReceiverPhone 복호화 및 마스킹 처리
      const decryptedEmailReceiverPhone = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.emailReceiverPhone);
      const maskedEmailReceiverPhone = decryptedEmailReceiverPhone ? MaskingUtil.maskDeliveryTarget(decryptedEmailReceiverPhone) : null;

      // 실제 발송 시간 계산 (발송 완료 상태일 때 actualSendAt 사용)
      let actualSendAt: string | null = null;
      if (
        (orderDelivery.status === 'COMPLETE' || orderDelivery.status === 'COMPLETE_SMS') &&
        orderDelivery.actualSendAt
      ) {
        actualSendAt = format(orderDelivery.actualSendAt, DateFormatStr);
      }

      // 초이스 쿠폰인 경우 선택된 상품의 가격 및 협력사 사용
      const displayProduct = orderDelivery.choiceSelectProduct ?? product;
      const displayPartnerCompany = orderDelivery.choiceSelectProduct?.partnerCompany ?? product.partnerCompany;

      // 유효기간 만료일: 발송 시점에 계산되어 저장된 expireAt 직접 사용
      const expireAt = orderDelivery.expireAt
        ? dayjs(orderDelivery.expireAt).format('YYYY-MM-DD')
        : null;

      // sendRequestAt 포맷팅
      let formattedSendRequestAt = '';
      if (orderDelivery.sendRequestAt) {
        formattedSendRequestAt = format(orderDelivery.sendRequestAt, DateFormatStr);
      } else if (orderDelivery.orderProductMapping.sendRequestAt) {
        formattedSendRequestAt = format(orderDelivery.orderProductMapping.sendRequestAt, DateFormatStr);
      }

      result.push({
        registerAt: format(orderDelivery.createdAt, DateFormatStr),
        sendRequestAt: formattedSendRequestAt,
        actualSendAt: actualSendAt,
        sendType: orderDelivery.orderProductMapping.sendType,
        id: order.id,
        orderDeliveryId: orderDelivery.id,
        orderProductMappingId: orderDelivery.orderProductMapping.id,
        eventName: order.eventName,
        sendTitle: orderDelivery.orderProductMapping.sendTitle ?? '',
        businessName: order.clientUser?.company?.businessName ?? order.user?.company?.businessName ?? '',
        productName: orderDelivery.choiceSelectProduct ? orderDelivery.choiceSelectProduct.name : product.name,
        price: displayProduct.price.toString(),
        productCode: product.code,
        status: order.status,
        fromPhoneNumber: orderDelivery.orderProductMapping.fromPhoneNumber,
        fromEmail: orderDelivery.orderProductMapping.fromEmail,
        deliveryTarget: maskedDeliveryTarget,
        transactionId: orderDelivery.transactionId || null,
        deliveryMethod: orderDelivery.deliveryMethod || null,
        couponStatus: orderDelivery.couponStatus ?? OrderDeliveryCouponStatus.NOT_USED,
        barCode: orderDelivery.barCode ? MaskingUtil.maskPinNumber(orderDelivery.barCode) : null,
        emailCouponStatus: orderDelivery.emailCouponStatus,
        emailReceiverPhone: maskedEmailReceiverPhone,
        refund: orderDelivery.refundRatio ?? null,
        expireAt,
      });
    }

    return {
      list: result,
      totalCount,
      totalPage,
      currentPage: page,
      totalPrice,
    };
  }

  async getDetailList(getQuery: CustomerServiceGetDetailListReqDto) {
    const { orderId, page, take } = getQuery;

    const queryBuilder = this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.brand', 'choiceBrand')
      .leftJoinAndSelect('choiceSelectProduct.partnerCompany', 'choicePartnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndMapOne(
        'product.partnerCompany',
        'partner_company',
        'partnerCompany',
        'partnerCompany.id = product.partner_company_id',
      )
      .where('order.id = :orderId', {
        orderId: orderId,
      });
    const skip = (page - 1) * take;
    queryBuilder.take(take).skip(skip);

    const [orderDeliveryList, totalCount] = await queryBuilder.getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const result: CustomerServiceDetailViewDto[] = [];
    for (const orderDelivery of orderDeliveryList) {
      // deliveryTarget 복호화 처리
      const decryptedDeliveryTarget = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget);

      // 실제 발송 시간 계산 (발송 완료 상태일 때 actualSendAt 사용)
      let actualSendAt: string | null = null;
      if (
        orderDelivery &&
        (orderDelivery.status === 'COMPLETE' || orderDelivery.status === 'COMPLETE_SMS') &&
        orderDelivery.actualSendAt
      ) {
        actualSendAt = format(orderDelivery.actualSendAt, DateFormatStr);
      }

      // 초이스 쿠폰인 경우 선택된 상품의 brand와 partnerCompany 사용
      const displayBrand = orderDelivery.choiceSelectProduct?.brand ?? orderDelivery.orderProductMapping.product.brand;
      const displayPartnerCompany =
        orderDelivery.choiceSelectProduct?.partnerCompany ?? orderDelivery.orderProductMapping.product.partnerCompany;

      // emailReceiverPhone 복호화 및 마스킹 처리
      const decryptedEmailReceiverPhone = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.emailReceiverPhone);
      const maskedEmailReceiverPhone = decryptedEmailReceiverPhone ? MaskingUtil.maskDeliveryTarget(decryptedEmailReceiverPhone) : null;

      result.push({
        id: orderDelivery.id,
        registerAt: format(orderDelivery.createdAt, DateFormatStr),
        productName: orderDelivery.choiceSelectProduct
          ? orderDelivery.choiceSelectProduct.name
          : orderDelivery.orderProductMapping.product.name,
        deliveryTarget: decryptedDeliveryTarget ?? '',
        barCode: orderDelivery.barCode,
        brandName: displayBrand?.nameKorean ?? '',
        partnerCompanyName: displayPartnerCompany?.businessName ?? '',
        eventName: orderDelivery.orderProductMapping.order.eventName,
        sendRequestAt: orderDelivery.sendRequestAt ? format(orderDelivery.sendRequestAt, DateFormatStr) : null,
        actualSendAt: actualSendAt,
        sendType: orderDelivery.orderProductMapping.sendType,
        tradeAt: orderDelivery.tradeAt ? format(orderDelivery.tradeAt, DateFormatStr) : null,
        tradePlace: orderDelivery.tradePlace || null,
        status: orderDelivery.status,
        couponStatus: orderDelivery.couponStatus,
        apiErrorMessage: orderDelivery.apiErrorMessage,
        method: orderDelivery.deliveryMethod,
        emailCouponStatus: orderDelivery.emailCouponStatus,
        emailReceiverPhone: maskedEmailReceiverPhone,
      });
    }

    return {
      list: result,
      totalCount,
      totalPage,
      currentPage: page,
    };
  }

  async getDetail(getQuery: CustomerServiceGetDetailReqDto): Promise<CustomerServiceDlvryDetailViewDto> {
    const { orderDeliveryId } = getQuery;

    const queryBuilder = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.brand', 'choiceBrand')
      .leftJoinAndSelect('choiceSelectProduct.partnerCompany', 'choicePartnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndMapOne(
        'product.partnerCompany',
        'partner_company',
        'partnerCompany',
        'partnerCompany.id = product.partner_company_id AND partnerCompany.deleted_at IS NULL',
      )
      .leftJoinAndMapOne('order.user', 'user', 'user', 'user.id = order.user_id AND user.deleted_at IS NULL')
      .leftJoinAndSelect('user.company', 'userCompany')
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .andWhere('orderDelivery.deletedAt IS NULL')
      .getOne();

    if (!queryBuilder) {
      throw new BadRequestException('존재하지 않는 발송 정보입니다.');
    }

    const product = queryBuilder.orderProductMapping.product;
    const partnerCompany = product.partnerCompany;
    const order = queryBuilder.orderProductMapping.order;
    const user = queryBuilder.orderProductMapping.order.user;

    // 초이스 쿠폰인 경우 선택된 상품의 brand와 partnerCompany 사용
    const displayBrand = queryBuilder.choiceSelectProduct?.brand ?? product.brand;
    const displayPartnerCompany = queryBuilder.choiceSelectProduct?.partnerCompany ?? partnerCompany;
    const displayProduct = queryBuilder.choiceSelectProduct ?? product;

    // deliveryTarget 복호화 처리
    const decryptedDeliveryTarget = this.cryptoCipher.safeDecryptDeliveryTarget(queryBuilder.deliveryTarget);

    // emailReceiverPhone 복호화 및 하이픈 포맷 처리 (history 페이지에서는 원문 표시)
    let formattedEmailReceiverPhone: string | null = null;
    if (queryBuilder.emailReceiverPhone) {
      try {
        const decryptedPhone = this.cryptoCipher.decryptDeliveryTarget(queryBuilder.emailReceiverPhone);
        formattedEmailReceiverPhone = PhoneUtil.formatWithHyphen(decryptedPhone);
      } catch (error) {
        // 복호화 실패 시 원본 데이터 사용
        formattedEmailReceiverPhone = queryBuilder.emailReceiverPhone;
      }
    }

    // 실제 발송 시간 계산 (발송 완료 상태일 때 actualSendAt 사용)
    let actualSendAt: string | null = null;
    if (
      queryBuilder &&
      (queryBuilder.status === 'COMPLETE' || queryBuilder.status === 'COMPLETE_SMS') &&
      queryBuilder.actualSendAt
    ) {
      actualSendAt = format(queryBuilder.actualSendAt, DateFormatStr);
    }

    // sendContent: order_product_mapping에서 가져오고, 대치문자 처리
    let sendContent = applyReplaceCharacters(
      queryBuilder.orderProductMapping.sendContent ?? '',
      queryBuilder,
    );

    return {
      orderDeliveryId: queryBuilder.id,
      eventName: order.eventName,
      businessName: user?.company?.businessName ?? '',
      personName: user?.personName ?? '',
      sendContent: sendContent,
      sendTitle: queryBuilder.orderProductMapping.sendTitle ?? null,
      deliveryTarget: decryptedDeliveryTarget ?? '',
      refundStatus: queryBuilder.refundStatus ?? null,
      refundRatio: queryBuilder.refundRatio ?? null,
      sendRequestAt: queryBuilder.sendRequestAt ? format(queryBuilder.sendRequestAt, DateFormatStr) : null,
      actualSendAt: actualSendAt,
      sendType: queryBuilder.orderProductMapping.sendType,
      method: queryBuilder.deliveryMethod,
      fromPhoneNumber: queryBuilder.orderProductMapping.fromPhoneNumber,
      partnerCompanyName: displayPartnerCompany?.businessName ?? '',
      productName: displayProduct.name,
      price: displayProduct.price.toString(),
      brandName: displayBrand?.nameKorean ?? '',
      code: displayProduct.code,
      couponStatus: queryBuilder.couponStatus,
      status: queryBuilder.status,
      apiErrorMessage: queryBuilder.apiErrorMessage,
      barCode: queryBuilder.barCode || null,
      tradeAt: queryBuilder.tradeAt ? format(queryBuilder.tradeAt, DateFormatStr) : null,
      tradePlace: queryBuilder.tradePlace || null,
      extraPinNo: queryBuilder.personalCode || null,
      expireDay: displayProduct.expireDay.toString(),
      transactionId: queryBuilder.transactionId || null,
      validityStartsNextDay: displayPartnerCompany?.validityStartsNextDay ?? true,
      expireAt: queryBuilder.expireAt ? dayjs(queryBuilder.expireAt).format('YYYY-MM-DD') : null,
      emailCouponStatus: queryBuilder.emailCouponStatus ?? null,
      emailReceiverPhone: formattedEmailReceiverPhone,
    };
  }

  async reSend(getBody: CustomerServiceReSendReqDto) {
    const { orderDeliveryId } = getBody;

    const queryBuilder = this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'company')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .andWhere('orderDelivery.status IN (:...status)', { status: ['COMPLETE', 'FAIL', 'COMPLETE_SMS', 'FAIL_SMS'] })
      .andWhere('orderDelivery.id = :orderDeliveryId', { orderDeliveryId: orderDeliveryId });

    const orderDelivery = await queryBuilder.getOne();

    if (!orderDelivery) {
      throw new BadRequestException('주문 발송가 존재하지 않습니다.');
    }

    if (orderDelivery.deliveryTarget === '-') {
      throw new BadRequestException('파기된 발송 정보입니다.');
    }

    await this.deliveryBatchService.oneSend(orderDelivery);

    return;
  }

  async pinDiscard(user: ILoginUserInfo, getBody: CustomerServiceDiscardReqDto) {
    const { orderDeliveryId, couponStatus } = getBody;

    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.partnerCompany', 'choicePartnerCompany')
      .where('orderDelivery.id = :orderDeliveryId', { orderDeliveryId: orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 주문 건입니다.');
    }

    // 초이스쿠폰의 경우 선택한 상품의 협력사를 우선 사용
    const partnerType =
      orderDelivery.choiceSelectProduct?.partnerCompany?.type ??
      orderDelivery.orderProductMapping?.product.partnerCompany?.type;
    const beforeChange = orderDelivery.couponStatus;

    // 외부 API 폐기 처리 (트랜잭션 밖에서 실행)
    switch (partnerType) {
      case 'GS_M_BIZ':
      case 'GIFT_SHOW':
      case 'CULTURELAND':
      case 'GALAXIA':
      case 'GIFTIEL':
      case 'DAOU': {
        if (beforeChange === 'USED' || beforeChange === 'CANCEL' || beforeChange === 'EXPIRED') {
          throw new BadRequestException('현재 변경을 할 수 없는 핀상태입니다.');
        }

        if (
          couponStatus === OrderDeliveryCouponStatus.CANCEL ||
          couponStatus === OrderDeliveryCouponStatus.REFUND_CANCEL
        ) {
          const result = await this.partnerCompanyExternService.cancel(orderDelivery);

          if (result.message !== '폐기 완료') {
            throw new InternalServerErrorException(result.message);
          }
        } else {
          throw new BadRequestException('변경을 할 수 없는 핀상태입니다.');
        }
        break;
      }
      case 'SSG': {
        if (beforeChange === 'USED' || beforeChange === 'EXPIRED') {
          throw new BadRequestException('현재 변경을 할 수 없는 핀상태입니다.');
        }

        if (
          couponStatus !== OrderDeliveryCouponStatus.CANCEL &&
          couponStatus !== OrderDeliveryCouponStatus.REFUND_CANCEL
        ) {
          throw new BadRequestException('변경을 할 수 없는 핀상태입니다.');
        }
        break;
      }
      default:
        break;
    }

    // 트랜잭션: couponStatus 저장 + 복구 + order_history
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      orderDelivery.couponStatus = couponStatus === OrderDeliveryCouponStatus.REFUND_CANCEL
        ? OrderDeliveryCouponStatus.REFUND_CANCEL
        : OrderDeliveryCouponStatus.CANCEL;
      await queryRunner.manager.save(OrderDeliveryEntity, orderDelivery);

      // 예치금/여신 복구
      await this.restoreBalanceOnDiscard(orderDelivery, user, queryRunner);

      // order_history 저장 (기존 pinDiscard에 없던 것 추가)
      const history = this.orderHistoryRepository.create({
        orderDeliveryId: orderDelivery.id,
        userId: user.id,
        type: '폐기',
        content: `핀폐기 처리`,
        beforeChange: beforeChange,
        afterChange: orderDelivery.couponStatus,
      });
      await queryRunner.manager.save(OrderHistoryEntity, history);

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async refreshCoupon(getQuery: CustomerServiceCouponRefreshReqDto) {
    const { orderDeliveryId } = getQuery;

    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.partnerCompany', 'choicePartnerCompany')
      .where('orderDelivery.id = :orderDeliveryId', { orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 orderDelivery 입니다.');
    }

    // 실시간 외부사 조회 → couponStatus 갱신
    const updated = await this.partnerCompanyExternService.refreshCouponStatus(orderDelivery);

    return {
      id: updated.id,
      couponStatus: updated.couponStatus,
      tradeAt: updated.tradeAt,
    };
  }

  /**
   * order_history 등록
   * @param map
   */
  async execCreateHistory(map: Partial<OrderHistoryEntity>) {
    return await this.orderHistoryRepository.save(map);
  }

  /**
   * 핀상태변경 API 유효성검사
   * @param getBody
   */
  async validPinStatusModify(getBody: CustomerServicePinStatusModifyReqDto) {
    if (!getBody.orderDeliveryId) throw new NotFoundException('데이터 정보가 없습니다.');
    if (!getBody.afterChange) throw new BadRequestException('변경 후 데이터가 없습니다.');
  }

  /**
   * 핀상태변경 API 데이터매핑
   * @param user
   * @param getBody
   * @returns
   */
  async mapPinStatusModify(@User() user: ILoginUserInfo, getBody: CustomerServicePinStatusModifyReqDto) {
    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: {
        id: getBody.orderDeliveryId,
        deletedAt: IsNull(),
      },
      relations: [
        'orderProductMapping',
        'orderProductMapping.product',
        'orderProductMapping.product.partnerCompany',
        'orderProductMapping.order',
        'choiceSelectProduct',
        'choiceSelectProduct.partnerCompany',
        'orderHistory',
      ],
    });

    if (!orderDelivery) {
      throw new BadRequestException('데이터가 존재하지 않습니다.');
    }

    return {
      businessName: orderDelivery?.orderProductMapping?.product?.partnerCompany?.businessName,
      beforeChange: orderDelivery.couponStatus,
      afterChange: getBody.afterChange,
      type: '핀상태 변경',
      content: '핀상태 변경',
      userId: user.id,
      user,
      orderDelivery,
    };
  }

  /**
   * 핀상태변경 API 서비스실행
   * @param map
   */
  async execPinStatusModify(map: any) {
    const { businessName, beforeChange, afterChange, type, content, orderDelivery } = map;

    switch (businessName) {
      case 'GS엠비즈':
      case '대홍기획':
      case '컬쳐랜드':
      case '갤럭시아':
      case '케이티알파':
      case '주식회사 다우기술':
        if (beforeChange === 'USED' || beforeChange === 'CANCEL' || beforeChange === 'EXPIRED') {
          throw new BadRequestException('현재 변경을 할 수 없는 핀상태입니다.');
        }

        if (afterChange === 'CANCEL' || afterChange === 'REFUND_CANCEL') {
          const result = this.partnerCompanyExternService.cancel(orderDelivery);

          if ((await result).message === '폐기 완료') {
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;

            await this.orderDeliveryRepository.save(orderDelivery);

            const history = this.orderHistoryRepository.create({
              orderDeliveryId: orderDelivery.id,
              userId: map.userId,
              type: type,
              content: content,
              beforeChange: beforeChange,
              afterChange: OrderDeliveryCouponStatus.CANCEL,
            });

            await this.orderHistoryRepository.save(history);
          } else {
            throw new InternalServerErrorException((await result).message);
          }
        } else {
          throw new BadRequestException('변경을 할 수 없는 핀상태입니다.');
        }

        break;
      case 'SSG':
        if (beforeChange === 'USED' || beforeChange === 'EXPIRED') {
          throw new BadRequestException('현재 변경을 할 수 없는 핀상태입니다.');
        }

        if (afterChange === 'CANCEL' || afterChange === 'REFUND_CANCEL') {
          orderDelivery.couponStatus = afterChange;

          await this.orderDeliveryRepository.save(orderDelivery);

          const history = this.orderHistoryRepository.create({
            orderDeliveryId: orderDelivery.id,
            userId: orderDelivery.userId,
            type: type,
            content: content,
            beforeChange: beforeChange,
            afterChange: afterChange,
          });

          await this.orderHistoryRepository.save(history);
        } else {
          throw new BadRequestException('변경을 할 수 없는 핀상태입니다.');
        }

        break;
      default:
        orderDelivery.couponStatus = afterChange;
        await this.orderDeliveryRepository.save(orderDelivery);
    }

    return;
  }

  /**
   * 핀상태갱신 API 유효성검사
   * @param getBody
   */
  async validPinStatusRefresh(getBody: CustomerServicePinStatusRefreshReqDto) {
    if (!getBody.orderDeliveryId) throw new NotFoundException('데이터 정보가 없습니다.');
  }

  /**
   * 핀상태갱신 API 데이터매핑
   * @param user
   * @param getBody
   * @returns
   */
  async mapPinStatusRefresh(@User() user: ILoginUserInfo, getBody: CustomerServicePinStatusRefreshReqDto) {
    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: {
        id: getBody.orderDeliveryId,
        deletedAt: IsNull(),
      },
      relations: [
        'orderProductMapping',
        'orderProductMapping.product',
        'orderProductMapping.order',
        'orderProductMapping.product.partnerCompany',
        'choiceSelectProduct',
        'choiceSelectProduct.partnerCompany',
        'orderHistory',
        'ssgEvent',
      ],
    });

    if (!orderDelivery) {
      throw new BadRequestException('데이터가 존재하지 않습니다.');
    }

    return {
      userId: user.id,
      type: '핀상태 변경',
      content: '핀상태 변경',
      beforeChange: orderDelivery.couponStatus,
      orderDelivery,
    };
  }

  /**
   * 핀상태갱신 API 서비스실행
   * @param map
   */
  async execPinStatusRefresh(map: any) {
    await this.partnerCompanyExternService.refreshCouponStatus(map.orderDelivery);

    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: {
        id: map.orderDelivery.id,
        deletedAt: IsNull(),
      },
      relations: ['orderProductMapping', 'orderProductMapping.product', 'orderProductMapping.order', 'orderHistory'],
    });

    const resCouponStatus = orderDelivery?.couponStatus;

    // 상태가 변경된 경우에만 히스토리 저장
    if (map.beforeChange !== resCouponStatus) {
      const history = this.orderHistoryRepository.create({
        orderDeliveryId: map.orderDelivery.id,
        userId: map.userId,
        type: map.type,
        content: map.content,
        beforeChange: map.beforeChange,
        afterChange: resCouponStatus,
      });

      await this.orderHistoryRepository.save(history);
    }
  }

  /**
   * CS 등록 API 유효성검사
   * @param getBody
   */
  async validHistory(getBody: CustomerServiceHistoryReqDto) {
    if (!getBody.orderDeliveryId) throw new NotFoundException('데이터 정보가 없습니다.');
    if (!getBody.type) {
      throw new BadRequestException('CS 유형을 선택해 주세요.');
    } else if (getBody.type === '재전송' && !getBody.extraType) {
      throw new BadRequestException('재전송 유형을 선택해 주세요.');
    }
  }

  /**
   * CS 등록 API 데이터매핑
   * @param user
   * @param getBody
   * @returns
   */
  async mapHistory(@User() user: ILoginUserInfo, getBody: CustomerServiceHistoryReqDto) {
    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: {
        id: getBody.orderDeliveryId,
        deletedAt: IsNull(),
      },
      relations: [
        'orderProductMapping',
        'orderProductMapping.product',
        'orderProductMapping.product.brand',
        'orderProductMapping.order',
        'orderHistory',
      ],
    });

    if (!orderDelivery) {
      throw new BadRequestException('데이터가 존재하지 않습니다.');
    }

    let beforeChange = '';
    let smsEntity;
    switch (getBody.type) {
      case '재전송': {
        switch (getBody.extraType) {
          case 'sms': {
            const orderType = orderDelivery.orderProductMapping.order.type;
            const productType = orderDelivery.orderProductMapping.product.type;

            let text: string;
            if (orderType === IOrderType.SSG) {
              text = smsSsgShortTemplate(orderDelivery);
            } else if (productType === IProductType.CHOICE) {
              // 초이스쿠폰: 선택 링크 발송
              const encryptKey = this.cryptoCipher.encryptJson({
                id: orderDelivery.id,
                transactionId: orderDelivery.transactionId,
              } as OrderEncryptKey);
              const choiceUrl = `${this.configService.getOrThrow('SMS_CHOICE_URL')}/${encryptKey}`;
              text = `초이스 쿠폰 받기 링크 : ${choiceUrl}`;
            } else {
              const expireDate = dayjs(orderDelivery.sendRequestAt)
                .tz('Asia/Seoul')
                .add(orderDelivery.orderProductMapping.product.expireDay, 'day')
                .format('YYYY-MM-DD');

              text =
                `[모바일상품권]` +
                orderDelivery.orderProductMapping.product.name +
                `/교환처:` +
                orderDelivery.orderProductMapping.product.brand?.nameKorean +
                `/쿠폰번호:` +
                orderDelivery.barCode +
                `/` +
                expireDate;
            }

            const decryptedTarget = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget) ?? '';
            const textBytes = Buffer.byteLength(text, 'utf8');

            smsEntity = this.gemteckMsgQueueRepository.create({
              msgType: textBytes <= 90 ? 'S' : 'L',
              dstAddr: decryptedTarget,
              callback: orderDelivery.orderProductMapping.fromPhoneNumber ?? '',
              text,
            });
            break;
          }
        }
        break;
      }
      case '수신정보 변경요청': {
        beforeChange = orderDelivery.deliveryTarget;
        break;
      }
      case '폐기':
      case '환불폐기': {
        beforeChange = orderDelivery.couponStatus;
        break;
      }
      default: {
        beforeChange = '';
      }
    }

    if (getBody.extraType === 'phone') {
      getBody.afterChange = getBody.afterChange?.replace(/[^0-9]/g, '').trim();
    }

    // 발송 수단 매핑
    const displayMethod = CustomerServiceService.DELIVERY_METHOD_DISPLAY[orderDelivery.deliveryMethod] ?? null;

    let sendMethod: string | null = null;
    if (getBody.type === '재전송') {
      switch (getBody.extraType) {
        case 'sms':
          sendMethod = 'SMS';
          break;
        case 'forced_mms':
          sendMethod = 'MMS';
          break;
        case 'mms': // 하위호환 (프론트 배포 후 Phase B에서 의미 변경 예정)
        case 'original':
          sendMethod = displayMethod;
          break;
      }
    } else if (getBody.type === '수신정보 변경요청') {
      sendMethod = displayMethod;
    }

    return {
      orderDeliveryId: getBody.orderDeliveryId,
      userId: user.id,
      user,
      type: getBody.type,
      extraType: getBody.extraType || '',
      content: getBody.content || '',
      beforeChange: beforeChange || '',
      afterChange: getBody.afterChange || '',
      sendMethod,
      orderDelivery,
      smsEntity,
    };
  }

  /**
   * CS 등록 API 서비스실행
   * @param map
   */
  async execHistory(map: any) {
    let afterChange = '';

    switch (map.type) {
      case '단순문의': {
        break;
      }
      case '재전송': {
        switch (map.extraType) {
          case 'sms': {
            await this.smsGemtekSend.smsSend(map.smsEntity);
            break;
          }
          case 'forced_mms': {
            await this.deliveryBatchService.csResendAsMms(map.orderDeliveryId);
            break;
          }
          case 'mms': // 하위호환 (프론트 배포 후 Phase B에서 의미 변경 예정)
          case 'original': {
            const resendDto = new CustomerServiceReSendReqDto();
            resendDto.orderDeliveryId = map.orderDeliveryId;

            await this.reSend(resendDto);
            break;
          }
          default: {
            throw new BadRequestException('지원하지 않는 재전송 유형입니다.');
          }
        }
        break;
      }
      case '수신정보 변경요청': {
        const orderDelivery = map.orderDelivery as OrderDeliveryEntity;
        const newTarget = map.afterChange;
        let encryptedNewTarget: string;

        // 이메일 발송 건에서 핀이 발급된 경우: emailReceiverPhone 변경
        // 그 외의 경우: deliveryTarget 변경
        if (
          orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL &&
          orderDelivery.barCode &&
          orderDelivery.emailReceiverPhone
        ) {
          // 핀이 발급된 이메일 쿠폰: 전화번호만 입력 가능
          if (!PhoneUtil.isValidPhone(newTarget)) {
            throw new BadRequestException('핀이 발급된 이메일 쿠폰은 유효한 전화번호만 입력 가능합니다.');
          }
          encryptedNewTarget = this.cryptoCipher.encryptDeliveryTarget(PhoneUtil.normalize(newTarget));
          await this.orderDeliveryRepository.update(map.orderDeliveryId, {
            emailReceiverPhone: encryptedNewTarget,
          });
        } else if (orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL && !orderDelivery.barCode) {
          // 핀이 발급되지 않은 이메일 쿠폰: 이메일만 입력 가능
          if (!PhoneUtil.isValidEmail(newTarget)) {
            throw new BadRequestException('핀이 발급되지 않은 이메일 쿠폰은 유효한 이메일 주소만 입력 가능합니다.');
          }
          encryptedNewTarget = this.cryptoCipher.encryptDeliveryTarget(newTarget);
          await this.orderDeliveryRepository.update(map.orderDeliveryId, {
            deliveryTarget: encryptedNewTarget,
          });
        } else {
          // 그 외 (SMS, 알림톡 등): 전화번호만 입력 가능
          if (!PhoneUtil.isValidPhone(newTarget)) {
            throw new BadRequestException('유효한 전화번호를 입력해 주세요.');
          }
          encryptedNewTarget = this.cryptoCipher.encryptDeliveryTarget(PhoneUtil.normalize(newTarget));
          await this.orderDeliveryRepository.update(map.orderDeliveryId, {
            deliveryTarget: encryptedNewTarget,
          });
        }

        const resendDto = new CustomerServiceReSendReqDto();
        resendDto.orderDeliveryId = map.orderDeliveryId;

        await this.reSend(resendDto);

        afterChange = encryptedNewTarget;
        break;
      }
      case '폐기': {
        const pinDiscardDto = new CustomerServiceDiscardReqDto();
        pinDiscardDto.orderDeliveryId = map.orderDeliveryId;
        pinDiscardDto.couponStatus = map.afterChange;

        await this.pinDiscard(map.user, pinDiscardDto);

        afterChange = OrderDeliveryCouponStatus.CANCEL;
        break;
      }
      case '환불폐기': {
        const pinDiscardDto = new CustomerServiceDiscardReqDto();
        pinDiscardDto.orderDeliveryId = map.orderDeliveryId;
        pinDiscardDto.couponStatus = map.afterChange;

        await this.pinDiscard(map.user, pinDiscardDto);

        afterChange = OrderDeliveryCouponStatus.REFUND_CANCEL;
        break;
      }
      default: {
        throw new BadRequestException('지원하지 않는 유형입니다.');
      }
    }

    const history = this.orderHistoryRepository.create({
      orderDeliveryId: map.orderDelivery.id,
      userId: map.userId,
      type: map.type,
      content: map.content,
      sendMethod: map.sendMethod,
      beforeChange: map.beforeChange,
      afterChange: afterChange,
    });

    await this.orderHistoryRepository.save(history);
  }

  /**
   * 변경내역 상세 list 조회 API 유효성검사
   * @param getQuery
   */
  async validStatusList(getQuery: CustomerServiceStatusListReqDto) {
    if (!getQuery.orderDeliveryId) throw new NotFoundException('발송 상세 데이터 정보가 없습니다.');
  }

  /**
   * 변경내역 상세 list 조회 API 데이터매핑
   * @param getQuery
   * @returns
   */
  async mapStatusList(getQuery: CustomerServiceStatusListReqDto) {
    return {
      orderDeliveryId: getQuery.orderDeliveryId,
      page: getQuery.page,
      take: getQuery.take,
    };
  }

  /**
   * 변경내역 상세 list 조회 API 서비스실행
   * @param map
   */
  async execStatusList(map: any) {
    const { orderDeliveryId, page, take } = map;

    const skip = (page - 1) * take;

    const queryBuilder = this.orderHistoryRepository
      .createQueryBuilder('history')
      .leftJoinAndSelect('history.user', 'user')
      .where('history.orderDeliveryId = :orderDeliveryId', { orderDeliveryId })
      .orderBy('history.id', 'DESC')
      .skip(skip)
      .take(take);

    const [list, totalCount] = await queryBuilder.getManyAndCount();

    return {
      list: list.map((h: OrderHistoryEntity) => {
        // 수신정보 변경요청일 경우 암호화된 deliveryTarget을 복호화
        let beforeChange = h.beforeChange;
        let afterChange = h.afterChange;

        if (h.type === '수신정보 변경요청') {
          beforeChange = this.cryptoCipher.safeDecryptDeliveryTarget(beforeChange) ?? beforeChange;
          afterChange = this.cryptoCipher.safeDecryptDeliveryTarget(afterChange) ?? afterChange;
        }

        return {
          id: h.id,
          type: h.type,
          createdAt: h.createdAt ? format(h.createdAt, DateFormatStr) : null,
          personName: h.user?.personName ?? '',
          content: h.content,
          sendMethod: h.sendMethod ?? null,
          beforeChange,
          afterChange,
        };
      }),
      totalCount,
      totalPage: Math.ceil(totalCount / take),
      currentPage: page,
    };
  }

  /**
   * 마스킹되지 않은 수신정보 조회 API
   * @param getQuery
   */
  async getUnmaskedDeliveryTarget(getQuery: CustomerServiceUnmaskedDeliveryTargetReqDto) {
    const { orderDeliveryId } = getQuery;

    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: {
        id: orderDeliveryId,
        deletedAt: IsNull(),
      },
    });

    if (!orderDelivery) {
      throw new NotFoundException('존재하지 않는 발송 정보입니다.');
    }

    // 이메일 발송 건에서 핀이 발급된 경우: emailReceiverPhone 반환
    // 그 외의 경우: deliveryTarget 반환
    let decryptedDeliveryTarget = '';

    if (
      orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL &&
      orderDelivery.barCode &&
      orderDelivery.emailReceiverPhone
    ) {
      // 핀이 발급된 이메일 쿠폰: emailReceiverPhone(핸드폰 번호) 반환
      try {
        decryptedDeliveryTarget = this.cryptoCipher.decryptDeliveryTarget(orderDelivery.emailReceiverPhone);
        decryptedDeliveryTarget = PhoneUtil.formatWithHyphen(decryptedDeliveryTarget);
      } catch (error) {
        decryptedDeliveryTarget = orderDelivery.emailReceiverPhone;
      }
    } else {
      // 그 외: deliveryTarget 반환
      if (orderDelivery.deliveryTarget) {
        try {
          decryptedDeliveryTarget = this.cryptoCipher.decryptDeliveryTarget(orderDelivery.deliveryTarget);
          // 이메일이 아닌 경우 (전화번호) 하이픈 포맷 적용
          if (!decryptedDeliveryTarget.includes('@')) {
            decryptedDeliveryTarget = PhoneUtil.formatWithHyphen(decryptedDeliveryTarget);
          }
        } catch (error) {
          // 복호화 실패 시 원본 데이터 사용
          decryptedDeliveryTarget = orderDelivery.deliveryTarget;
        }
      }
    }

    return {
      deliveryTarget: decryptedDeliveryTarget,
    };
  }

  async refund(getDto: CustomerServiceRefundReqDto): Promise<void> {
    const { orderDeliveryId, refundRatio } = getDto;

    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: {
        id: orderDeliveryId,
      },
    });

    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 발송 정보입니다.');
    }

    orderDelivery.refundRatio = refundRatio;
    orderDelivery.refundRegisterAt = new Date();
    orderDelivery.refundStatus = OrderDeliveryRefundStatusEnum.PROGRESS;

    await this.orderDeliveryRepository.save(orderDelivery);
    return;
  }

  /**
   * 다중 폐기 API
   * @param user 로그인 사용자 정보
   * @param orderDeliveryIds 폐기할 order_delivery ID 목록
   * @param content CS 내용
   */
  async bulkDiscard(
    user: ILoginUserInfo,
    orderDeliveryIds: number[],
    content: string,
  ): Promise<{ success: number[]; failed: { id: number; reason: string }[] }> {
    const success: number[] = [];
    const failed: { id: number; reason: string }[] = [];

    // QueryRunner를 루프 밖에서 생성하여 커넥션 풀 효율화
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      for (const orderDeliveryId of orderDeliveryIds) {
        try {
          // 1. orderDelivery 조회 (order relation 추가 - 복구 로직에 필요)
          const orderDelivery = await this.orderDeliveryRepository.findOne({
            where: {
              id: orderDeliveryId,
              deletedAt: IsNull(),
            },
            relations: [
              'orderProductMapping',
              'orderProductMapping.product',
              'orderProductMapping.product.partnerCompany',
              'orderProductMapping.order',
              'choiceSelectProduct',
              'choiceSelectProduct.partnerCompany',
            ],
          });

          if (!orderDelivery) {
            failed.push({ id: orderDeliveryId, reason: '존재하지 않는 발송 정보입니다.' });
            continue;
          }

          // 2. 현재 핀 상태 확인 - 이미 폐기된 경우 스킵
          if (
            orderDelivery.couponStatus === OrderDeliveryCouponStatus.CANCEL ||
            orderDelivery.couponStatus === OrderDeliveryCouponStatus.REFUND_CANCEL
          ) {
            failed.push({ id: orderDeliveryId, reason: '이미 폐기된 상태입니다.' });
            continue;
          }

          // 3. 교환 또는 기간만료 상태인 경우 폐기 불가
          if (
            orderDelivery.couponStatus === OrderDeliveryCouponStatus.USED ||
            orderDelivery.couponStatus === OrderDeliveryCouponStatus.EXPIRED
          ) {
            failed.push({ id: orderDeliveryId, reason: '교환 또는 기간만료 상태는 폐기할 수 없습니다.' });
            continue;
          }

          const beforeChange = orderDelivery.couponStatus;
          // 초이스쿠폰의 경우 선택한 상품의 협력사를 우선 사용
          const partnerCompanyName =
            orderDelivery.choiceSelectProduct?.partnerCompany?.businessName ??
            orderDelivery.orderProductMapping?.product?.partnerCompany?.businessName;

          // 4. 협력사별 폐기 처리 (외부 API - 트랜잭션 밖에서 실행)
          switch (partnerCompanyName) {
            case 'GS엠비즈':
            case '대홍기획':
            case '컬쳐랜드':
            case '갤럭시아':
            case '케이티알파':
            case '주식회사 다우기술': {
              const result = await this.partnerCompanyExternService.cancel(orderDelivery);
              if (result.message !== '폐기 완료') {
                failed.push({ id: orderDeliveryId, reason: result.message || '외부 API 폐기 실패' });
                continue;
              }
              orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
              break;
            }
            case 'SSG':
            default: {
              orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
              break;
            }
          }

          // 5. 트랜잭션: couponStatus 저장 + 복구 + CS 히스토리 (건별 트랜잭션)
          await queryRunner.startTransaction();
          try {
            await queryRunner.manager.save(OrderDeliveryEntity, orderDelivery);

            // 예치금/여신 복구
            await this.restoreBalanceOnDiscard(orderDelivery, user, queryRunner);

            // CS 히스토리 저장
            const history = this.orderHistoryRepository.create({
              orderDeliveryId: orderDelivery.id,
              userId: user.id,
              type: '폐기',
              content: content,
              beforeChange: beforeChange,
              afterChange: OrderDeliveryCouponStatus.CANCEL,
            });
            await queryRunner.manager.save(OrderHistoryEntity, history);

            await queryRunner.commitTransaction();
          } catch (txError) {
            await queryRunner.rollbackTransaction();
            throw txError;
          }

          success.push(orderDeliveryId);
        } catch (error: any) {
          failed.push({
            id: orderDeliveryId,
            reason: error.message || '폐기 처리 중 오류가 발생했습니다.',
          });
        }
      }
    } finally {
      await queryRunner.release();
    }

    return { success, failed };
  }

  /**
   * CS 리스트 엑셀 다운로드
   * @param user 로그인 사용자 정보
   * @param dto 검색 조건 및 다운로드 정보
   * @param res Express Response
   */
  async excelDownload(user: ILoginUserInfo, dto: CustomerServiceExcelDownloadReqDto, res: Response): Promise<void> {
    const startTime = Date.now();
    const { password, downloadReason, orderDeliveryIds, keyword, ...searchParams } = dto;
    const {
      orderType,
      startAt,
      endAt,
      userCompanyId,
      couponStatus,
      orderNumber,
      productName,
      productCode,
      deliveryTarget,
      sendTitle,
      partnerCompanyId,
      eventName,
    } = searchParams;

    // 1. 비밀번호 검증
    await this.activityLogService.verifyPassword(user.id, password);

    // 2. 데이터 조회 (페이징 없이 전체 조회)
    let queryBuilder = this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndMapOne('order.user', 'user', 'user', 'user.id = order.user_id AND user.deleted_at IS NULL')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndMapOne('order.clientUser', 'user', 'clientUser', 'clientUser.id = order.client_user_id AND clientUser.deleted_at IS NULL')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .andWhere('orderDelivery.status IN (:...deliveryStatus)', { deliveryStatus: ['COMPLETE', 'COMPLETE_SMS'] })
      .andWhere('orderDelivery.deletedAt IS NULL');

    // 선택한 ID들이 있으면 해당 ID들만 조회
    if (orderDeliveryIds && orderDeliveryIds.length > 0) {
      queryBuilder.andWhere('orderDelivery.id IN (:...orderDeliveryIds)', { orderDeliveryIds });
    }

    if (orderType === 'GENERAL') {
      queryBuilder.andWhere('product.type IN (:...types)', { types: ['GENERAL', 'CHOICE'] });
    }

    if (orderType === 'SSG') {
      queryBuilder.andWhere('product.type = :type', { type: 'SSG' });
    }

    // 고객사 (userCompanyId)
    if (userCompanyId) {
      queryBuilder.andWhere('user.companyId = :userCompanyId', { userCompanyId });
    }

    if (orderNumber) {
      queryBuilder.andWhere('CAST(order.id AS CHAR) LIKE :orderNumber', { orderNumber: `%${orderNumber}%` });
    }

    if (couponStatus) {
      queryBuilder.andWhere('orderDelivery.couponStatus = :couponStatus', { couponStatus });
    }

    if (productName) {
      queryBuilder.andWhere('product.name LIKE :productName', { productName: `%${productName}%` });
    }

    if (productCode) {
      queryBuilder.andWhere('product.code LIKE :productCode', { productCode: `%${productCode}%` });
    }

    if (deliveryTarget) {
      const normalizedTarget = PhoneUtil.normalizeDeliveryTarget(deliveryTarget);
      const encryptedTarget = this.cryptoCipher.encryptDeliveryTarget(normalizedTarget);
      queryBuilder.andWhere('orderDelivery.deliveryTarget = :deliveryTarget', { deliveryTarget: encryptedTarget });
    }

    if (sendTitle) {
      queryBuilder.andWhere('orderProductMapping.sendTitle LIKE :sendTitle', { sendTitle: `%${sendTitle}%` });
    }

    if (partnerCompanyId) {
      queryBuilder.andWhere('product.partnerCompanyId = :partnerCompanyId', { partnerCompanyId });
    }

    // 통합검색 (주문번호, 상품명, 상품코드, MMS제목, 수신정보를 OR 조건으로 검색)
    if (keyword) {
      const normalizedKeyword = PhoneUtil.normalizeDeliveryTarget(keyword);
      const encryptedKeyword = this.cryptoCipher.encryptDeliveryTarget(normalizedKeyword);
      queryBuilder.andWhere(
        `(CAST(order.id AS CHAR) LIKE :keyword
          OR product.name LIKE :keyword
          OR product.code LIKE :keyword
          OR orderProductMapping.sendTitle LIKE :keyword
          OR order.eventName LIKE :keyword
          OR orderDelivery.deliveryTarget = :encryptedKeyword)`,
        { keyword: `%${keyword}%`, encryptedKeyword },
      );
    }

    // 이벤트명 (부분검색)
    if (eventName) {
      queryBuilder.andWhere('order.eventName LIKE :eventName', { eventName: `%${eventName}%` });
    }

    // 날짜 조건을 실제 발송일(actualSendAt) 기준으로 변경
    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'orderDelivery', 'actualSendAt', startAt, endAt);
    queryBuilder.orderBy('orderDelivery.actualSendAt', 'DESC');

    const orderDeliveryList = await queryBuilder.getMany();

    // 3. 엑셀 워크북 생성
    const workbook = new ExcelJS.Workbook();
    const sheetName = orderType === 'GENERAL' ? '일반쿠폰주문CS' : '신세계CS';
    const worksheet = workbook.addWorksheet(sheetName);
    const isSSG = orderType === 'SSG';

    // 4. 컬럼 정의 (신세계는 개인번호 컬럼 포함)
    const baseColumns = [
      { header: '실발송일', key: 'actualSendAt', width: 20 },
      { header: '고객사', key: 'businessName', width: 20 },
      { header: '이벤트명', key: 'eventName', width: 30 },
      { header: 'MMS제목', key: 'sendTitle', width: 30 },
      { header: '상품명', key: 'productName', width: 40 },
      { header: '금액', key: 'price', width: 15 },
      { header: '상품코드', key: 'productCode', width: 15 },
      { header: '수신정보', key: 'deliveryTarget', width: 20 },
      { header: '이메일쿠폰수령번호', key: 'emailReceiverPhone', width: 18 },
      { header: '발송방법', key: 'deliveryMethod', width: 12 },
      { header: '발신번호', key: 'fromPhoneNumber', width: 15 },
    ];

    // 신세계인 경우 개인번호(쿠폰번호) 컬럼 추가
    if (isSSG) {
      baseColumns.push({ header: '개인번호(쿠폰번호)', key: 'personalCode', width: 25 });
    }

    baseColumns.push(
      { header: '핀번호', key: 'barCode', width: 25 },
      { header: '핀상태', key: 'couponStatus', width: 12 },
      { header: '교환 일시·장소', key: 'tradeInfo', width: 30 },
      { header: '거래번호', key: 'transactionId', width: 20 },
    );

    worksheet.columns = baseColumns;

    // 5. 헤더 스타일 적용
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };

    // 6. 데이터 행 추가
    for (const orderDelivery of orderDeliveryList) {
      const order = orderDelivery.orderProductMapping.order;
      const product = orderDelivery.orderProductMapping.product;

      // deliveryTarget 복호화 (엑셀 다운로드 시 원문 표시)
      const decryptedDeliveryTarget = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget);

      // emailReceiverPhone 복호화 (이메일 쿠폰 수령 시 입력한 핸드폰 번호)
      const decryptedEmailReceiverPhone = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.emailReceiverPhone);

      // 실제 발송 시간 계산
      let actualSendAt: string | null = null;
      if (
        (orderDelivery.status === 'COMPLETE' || orderDelivery.status === 'COMPLETE_SMS') &&
        orderDelivery.actualSendAt
      ) {
        actualSendAt = format(orderDelivery.actualSendAt, DateFormatStr);
      }

      // 초이스 쿠폰인 경우 선택된 상품의 가격 사용
      const displayProduct = orderDelivery.choiceSelectProduct ?? product;

      // 교환 일시·장소 조합
      let tradeInfo = '';
      if (orderDelivery.tradeAt) {
        tradeInfo = format(orderDelivery.tradeAt, DateFormatStr);
        if (orderDelivery.tradePlace) {
          tradeInfo += ` ${orderDelivery.tradePlace}`;
        }
      } else if (orderDelivery.tradePlace) {
        tradeInfo = orderDelivery.tradePlace;
      }

      worksheet.addRow({
        actualSendAt: actualSendAt || '',
        businessName: order.clientUser?.company?.businessName ?? order.user?.company?.businessName ?? '',
        eventName: order.eventName,
        sendTitle: orderDelivery.orderProductMapping.sendTitle ?? '',
        productName: orderDelivery.choiceSelectProduct ? orderDelivery.choiceSelectProduct.name : product.name,
        price: displayProduct.price,
        productCode: product.code,
        deliveryTarget: decryptedDeliveryTarget || '',
        emailReceiverPhone: decryptedEmailReceiverPhone || '',
        deliveryMethod: orderDelivery.deliveryMethod || '',
        fromPhoneNumber: orderDelivery.orderProductMapping.fromPhoneNumber || '',
        personalCode: orderDelivery.personalCode || '',
        barCode: orderDelivery.barCode || '',
        couponStatus: couponStatusToKorean(orderDelivery.couponStatus) || '',
        tradeInfo,
        transactionId: orderDelivery.transactionId || '',
      });
    }

    // 7. Activity Log 기록
    const responseTime = Date.now() - startTime;
    const recordCount = orderDeliveryList.length;

    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/customer-service/excel-download',
      actionType: ActivityLogActionType.EXCEL_DOWNLOAD,
      ipAddress: res.req?.ip || '',
      userAgent: res.req?.headers?.['user-agent'] || '',
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime,
      downloadReason,
      recordCount,
      requestParams: searchParams,
    });

    // 8. 엑셀 파일 전송
    const nowString = format(new Date(), 'yyyyMMdd_HHmmss');
    const fileName = `${sheetName}_${nowString}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    await workbook.xlsx.write(res);
    res.end();
  }

}
