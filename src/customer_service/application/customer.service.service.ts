import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
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
import { Transactional } from 'typeorm-transactional';
import { OrderEntity } from '../../entity/order.entity';
import { DataSource, IsNull, QueryRunner, Repository } from 'typeorm';
import { CustomerServiceGetListResDto } from '../api/customer.service.res.dto';
import { DateFormatStr, DateEndMinuteFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { CustomerServiceViewDto } from '../api/dto/customer.service.view.dto';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { CustomerServiceDetailViewDto } from '../api/dto/customer.service.detail.view.dto';
import { CustomerServiceDlvryDetailViewDto } from '../api/dto/customer.service.dlvry.detail.view.dto';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { DeliveryBatchService } from '../../delivery/application/delivery.batch.service';
import { RefundLedgerService } from '../../delivery/application/refund-ledger.service';
import { WalletManagedPredicate } from '../../wallet/application/wallet-managed.predicate';
import { RefundPoolService } from '../../wallet/application/refund-pool.service';
import { OrderDeliveryAttemptEntity } from '../../entity/order.delivery.attempt.entity';
import { OrderPaymentRefundEventType } from '../../entity/order.payment.refund.event.entity';
import { buildDiscardRefundKey } from '../../wallet/interface/wallet-idempotency';
import { WalletResourceType } from '../../wallet/interface/wallet-resource-type';
import { OrderDeliveryRefundRestoreType } from '../../entity/order.delivery.refund.entity';
import { OrderDeliveryCouponStatus, couponStatusToKorean } from '../../delivery/interface/order.delivery.coupon.status';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { IProductType } from '../../product/interface/product.type';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { UserAuthListDefault } from '../../user_info/domain/user.auth.list.default';
import { ILoginUserInfo } from 'src/auth/interface/login.user';
import { OrderHistoryEntity } from 'src/entity/order.history.entity';
import { User } from 'src/auth/api/user.decorator';
import { GemteckMsgQueueEntity } from 'src/entity/gemtek/msg.queue.entity';
import { SmsGemtekSend } from 'src/sms/infra/sms.gemtek.send';
import { MaskingUtil } from 'src/common/utils/masking.util';
import { CryptoCipher } from 'src/common/infra/crypto.cipher';
import { PhoneUtil } from 'src/common/utils/phone.util';
import { UserTaskHistoryEntity } from 'src/entity/user.task.history.entity';
import { OrderDeliveryRefundStatusEnum } from '../../delivery/interface/order.delivery.refund.status.enum';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { IOrderType } from '../../order/interface/order.type';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { SsgRefundOutcome } from '../../delivery/interface/ssg.refund.resolve';
import { resolveExpireDays } from '../../common/utils/expire.util';
import { addDays, subDays } from 'date-fns';
import { ActivityLogService } from 'src/activity_log/application/activity.log.service';
import { ActivityLogActionType } from 'src/activity_log/interface/activity.log.action.type';
import { ActivityLogResult } from 'src/activity_log/interface/activity.log.result';
import { UserEntity } from 'src/entity/user.entity';
import { UserCompanyEntity } from 'src/entity/user.company.entity';
import { calculateSettlementPrice } from '../../util/settle-fee.util';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { randomUUID } from 'crypto';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import * as fs from 'fs';
import { createExportTempPath } from '../../util/file.util';

const dayjs = require('dayjs');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(timezone);

@Injectable()
export class CustomerServiceService {
  private readonly logger = new Logger(CustomerServiceService.name);

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
    private refundLedgerService: RefundLedgerService,
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
    @InjectRepository(UserTaskHistoryEntity)
    private readonly userTaskHistoryRepository: Repository<UserTaskHistoryEntity>,
    private readonly dataSource: DataSource,
    private readonly walletManagedPredicate: WalletManagedPredicate,
    private readonly refundPoolService: RefundPoolService,
    private readonly authService: AuthService,
  ) {}

  /**
   * 폐기 시 정산금액(할인가) 기준으로 예치금/여신 복구.
   *
   * 환불 라우팅:
   * - 정산확정 후(isSettleComplete=true) → 선입금(balance)으로 복원
   *   (한도 사용분도 정산확정 시 allSettleAmount가 이미 0으로 차감됐으므로
   *    여기서 또 차감하면 음수가 된다. 정산확정된 환불은 선입금 환불로 처리)
   * - 미정산 + isSettleBalance=true → balance 복원 (기존 로직)
   * - 미정산 + isSettleBalance=false → allSettleAmount 차감 (여신 복구, 기존 로직)
   *
   * 멱등성: order_delivery_refund UNIQUE 제약으로 동일 발송건의 두 번째 환불 시도 차단.
   *
   * 스킵 조건:
   * - refund ledger 존재(exists): 이미 환불됨 (financial SoT). status===FAIL 프록시 대신 사용 —
   *   FAIL 이어도 ledger 없으면(보류) 복구 수행, FAIL 아니어도 ledger 있으면 이중 복구 차단
   * - REFUND_CANCEL: 수령 고객 환불 건, 고객사 정산과 무관
   */
  private async restoreBalanceOnDiscard(
    orderDelivery: OrderDeliveryEntity,
    operatorUser: ILoginUserInfo,
    queryRunner: QueryRunner,
    operatorName?: string,
  ): Promise<number | null> {
    const mapping = orderDelivery.orderProductMapping;
    const order = mapping.order;

    // 이미 환불됨이면 폐기 복구 skip. 판단 기준은 financial SoT = refund ledger 존재 여부(exists)이며,
    // status===FAIL 프록시를 쓰지 않는다. FAIL 이어도 ledger 가 없으면(보류: 차감 유지, 발송 미성립)
    // 폐기 시 복구해야 하고, 반대로 FAIL 이 아니어도 이미 환불 ledger 가 있으면 이중 복구를 막아야 한다.
    if (await this.refundLedgerService.exists(orderDelivery.id)) {
      return null;
    }

    if (orderDelivery.couponStatus === OrderDeliveryCouponStatus.REFUND_CANCEL) {
      return null;
    }

    let restoreAmount = calculateSettlementPrice(mapping, order.cardSurchargeApplied, orderDelivery);

    const billingUserId = order.clientUserId ?? order.userId;
    const user = await queryRunner.manager.findOne(UserEntity, {
      where: { id: billingUserId },
      relations: ['company'],
    });
    if (!user) return null;

    const company = user.company;
    const isCompanyBalanceMode = company?.balanceManagementType === 'COMPANY';
    const shouldRestoreBalance = order.isSettleComplete || order.isSettleBalance;
    let restoreType: OrderDeliveryRefundRestoreType;
    if (!shouldRestoreBalance) {
      restoreType = 'ALL_SETTLE_AMOUNT';
    } else if (isCompanyBalanceMode) {
      restoreType = 'COMPANY_BALANCE';
    } else {
      restoreType = 'BALANCE';
    }

    const isWalletManaged = await this.walletManagedPredicate.isWalletManaged(order.id, queryRunner.manager);
    let latestAttempt: OrderDeliveryAttemptEntity | null = null;
    if (isWalletManaged && order.isSettleComplete) {
      latestAttempt = await queryRunner.manager.findOne(OrderDeliveryAttemptEntity, {
        where: { orderDeliveryId: orderDelivery.id },
        order: { id: 'DESC' },
      });
      if (!latestAttempt) {
        throw new Error(
          `wallet-managed delivery ${orderDelivery.id} missing delivery attempt — drift, aborting discard refund`,
        );
      }
      const walletRefund = await this.refundPoolService.refundSettledDiscardToDeposit(
        {
          orderId: order.id,
          orderDeliveryId: orderDelivery.id,
          refundAmount: restoreAmount,
          idempotencyKeyPrefix: buildDiscardRefundKey(
            order.id,
            orderDelivery.id,
            WalletResourceType.DEPOSIT,
            Number(latestAttempt.id),
          ),
        },
        queryRunner.manager,
      );
      if (walletRefund.alreadyRefunded) {
        return null;
      }
      restoreAmount = walletRefund.totalRefundedAmount;
    }

    await this.refundLedgerService.claimWithManager(queryRunner.manager, {
      orderDeliveryId: orderDelivery.id,
      userId: billingUserId,
      refundAmount: restoreAmount,
      restoreType,
      isSettleComplete: order.isSettleComplete,
      isSettleBalance: order.isSettleBalance,
      sourcePath: 'CS_DISCARD',
      operatorUserId: operatorUser.id,
      memo: `폐기복구/${restoreAmount}원`,
    });

    let beforeBalance: number;
    let afterBalance: number;

    if (shouldRestoreBalance) {
      if (isCompanyBalanceMode && company) {
        await queryRunner.manager
          .createQueryBuilder()
          .update(UserCompanyEntity)
          .set({ balance: () => 'balance + :amount' })
          .where('id = :id', { id: company.id })
          .setParameters({ amount: restoreAmount })
          .execute();
        const fresh = await queryRunner.manager.findOne(UserCompanyEntity, { where: { id: company.id } });
        afterBalance = fresh!.balance;
        beforeBalance = afterBalance - restoreAmount;
      } else {
        await queryRunner.manager
          .createQueryBuilder()
          .update(UserEntity)
          .set({ balance: () => 'balance + :amount' })
          .where('id = :id', { id: user.id })
          .setParameters({ amount: restoreAmount })
          .execute();
        const fresh = await queryRunner.manager.findOne(UserEntity, { where: { id: user.id } });
        afterBalance = fresh!.balance;
        beforeBalance = afterBalance - restoreAmount;
      }
    } else {
      await queryRunner.manager
        .createQueryBuilder()
        .update(UserEntity)
        .set({ allSettleAmount: () => 'all_settle_amount - :amount' })
        .where('id = :id', { id: user.id })
        .setParameters({ amount: restoreAmount })
        .execute();
      const fresh = await queryRunner.manager.findOne(UserEntity, { where: { id: user.id } });
      afterBalance = fresh!.allSettleAmount;
      beforeBalance = afterBalance + restoreAmount;
    }

    const refundRouteMemo = order.isSettleComplete
      ? '정산확정후폐기/선입금환불'
      : order.isSettleBalance
        ? '미정산/선입금환불'
        : '미정산/여신복구';

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
        targetBusinessName: company?.businessName ?? '',
        targetCompanyId: company?.id ?? null,
        orderDeliveryId: orderDelivery.id,
        orderId: order.id,
        restoreAmount,
        isSettleBalance: order.isSettleBalance,
        isSettleComplete: order.isSettleComplete,
        restoreType,
        beforeBalance,
        afterBalance,
        memo: `폐기복구(${refundRouteMemo})/ ${restoreAmount}원/ orderDelivery:${orderDelivery.id}`,
      },
    });

    // 계정관리 > 이력관리 항목 기록
    if (!operatorName) {
      const operatorEntity = await queryRunner.manager.findOne(UserEntity, {
        where: { id: operatorUser.id },
      });
      operatorName = operatorEntity?.personName ?? operatorUser.email;
    }
    const contactNumber = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget) ?? '-';
    const now = format(new Date(), DateEndMinuteFormatStr);

    await queryRunner.manager.save(UserTaskHistoryEntity, {
      userId: billingUserId,
      adminUserId: operatorUser.id,
      content: `${operatorName}/ ${restoreAmount.toLocaleString()}원 폐기/ 회수/ ${contactNumber} 폐기/ ${now}`,
    });

    // Wallet Cutover Bundle PR4 — wallet-managed 주문이면 wallet_account + wallet ledger 갱신.
    // legacy 잔액 mirror (위 balance/allSettleAmount UPDATE) 는 그대로 유지 → wallet/legacy 합계 일관.
    // 멱등키 = discard_refund:{orderId}:{deliveryId}:{attemptId} — attempt cycle 별 멱등.
    if (isWalletManaged) {
      latestAttempt =
        latestAttempt ??
        (await queryRunner.manager.findOne(OrderDeliveryAttemptEntity, {
          where: { orderDeliveryId: orderDelivery.id },
          order: { id: 'DESC' },
        }));
      if (!latestAttempt) {
        throw new Error(
          `wallet-managed delivery ${orderDelivery.id} missing delivery attempt — drift, aborting discard refund`,
        );
      }
      if (order.isSettleComplete) {
        return restoreAmount;
      } else {
        await this.refundPoolService.refund(
          {
            orderId: order.id,
            eventType: OrderPaymentRefundEventType.DISCARD_REFUND,
            targetDeliveryIds: [orderDelivery.id],
            idempotencyKeyPrefix: `discard_refund:${order.id}:${orderDelivery.id}:${latestAttempt.id}`,
          },
          queryRunner.manager,
        );
      }
    }

    return restoreAmount;
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
      barCode,
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
      queryBuilder.andWhere(
        '(user.companyId = :userCompanyId OR clientUser.companyId = :userCompanyId)',
        { userCompanyId },
      );
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
          OR orderDelivery.deliveryTarget = :encryptedKeyword
          OR orderDelivery.emailReceiverPhone = :encryptedKeyword
          OR orderDelivery.barCode LIKE :keyword
          OR orderDelivery.personalCode LIKE :keyword)`,
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

    // 수신정보 (전문검색 - 암호화하여 비교, 이메일쿠폰 수령 핸드폰번호도 포함)
    if (deliveryTarget) {
      const normalizedTarget = PhoneUtil.normalizeDeliveryTarget(deliveryTarget);
      const encryptedTarget = this.cryptoCipher.encryptDeliveryTarget(normalizedTarget);
      queryBuilder.andWhere(
        '(orderDelivery.deliveryTarget = :deliveryTarget OR orderDelivery.emailReceiverPhone = :deliveryTarget)',
        { deliveryTarget: encryptedTarget },
      );
    }

    // MMS제목 (부분검색)
    if (sendTitle) {
      queryBuilder.andWhere('orderProductMapping.sendTitle LIKE :sendTitle', { sendTitle: `%${sendTitle}%` });
    }

    // 협력사 (초이스쿠폰은 partnerCompanyId=0 sentinel이므로 undefined/null만 미필터 처리)
    if (partnerCompanyId != null) {
      queryBuilder.andWhere('product.partnerCompanyId = :partnerCompanyId', { partnerCompanyId });
    }

    // 핀번호 (barCode + personalCode OR 조건 부분검색)
    if (barCode) {
      queryBuilder.andWhere(
        '(orderDelivery.barCode LIKE :barCode OR orderDelivery.personalCode LIKE :barCode)',
        { barCode: `%${barCode}%` },
      );
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

  async getDetailList(user: ILoginUserInfo, getQuery: CustomerServiceGetDetailListReqDto) {
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

    // 권한검사: 페이지와 무관하게 "주문 전체 발송"의 쿠폰 종류(일반/SSG)별 CS 권한을 모두 요구.
    // 페이지네이션된 결과로 검사하면 빈 페이지(범위 밖) 요청 시 requiredAuths 가 비어 검사가 스킵되고,
    // totalCount/totalPage 로 주문 존재·발송 건수가 노출된다. → distinct product.type 조회를 pagination 과 분리.
    // (getList 분류 기준과 동일, 그 외 타입은 거부)
    const productTypeRows = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoin('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoin('orderProductMapping.order', 'order')
      .innerJoin('orderProductMapping.product', 'product')
      .where('order.id = :orderId', { orderId })
      .select('DISTINCT product.type', 'type')
      .getRawMany<{ type: IProductType }>();

    if (productTypeRows.length === 0) {
      throw new BadRequestException('존재하지 않는 주문입니다.');
    }

    const requiredAuths = new Set<UserAuthSubEnum>();
    for (const row of productTypeRows) {
      const auth = this.resolveCsCouponAuthority(row.type);
      if (!auth) {
        throw new BadRequestException('CS 대상이 아닌 상품 유형입니다.');
      }
      requiredAuths.add(auth);
    }
    for (const auth of requiredAuths) {
      await this.authService.authorityValidator(user, auth);
    }

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
        replacedFromId: orderDelivery.replacedFromId ?? null,
      });
    }

    return {
      list: result,
      totalCount,
      totalPage,
      currentPage: page,
    };
  }

  async getDetail(user: ILoginUserInfo, getQuery: CustomerServiceGetDetailReqDto): Promise<CustomerServiceDlvryDetailViewDto> {
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

    // 권한검사: 쿠폰 종류(일반/SSG)에 맞는 CS 권한 (getList 분류 기준과 동일, 그 외 타입은 거부)
    const requiredAuth = this.resolveCsCouponAuthority(queryBuilder.orderProductMapping?.product?.type);
    if (!requiredAuth) {
      throw new BadRequestException('CS 대상이 아닌 상품 유형입니다.');
    }
    await this.authService.authorityValidator(user, requiredAuth);

    const product = queryBuilder.orderProductMapping.product;
    const partnerCompany = product.partnerCompany;
    const order = queryBuilder.orderProductMapping.order;
    // 주의: 파라미터 user(로그인 운영자)와 충돌 방지를 위해 주문자(고객사)는 orderUser 로 둔다.
    const orderUser = queryBuilder.orderProductMapping.order.user;

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
      businessName: orderUser?.company?.businessName ?? '',
      personName: orderUser?.personName ?? '',
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
      replacedFromId: queryBuilder.replacedFromId ?? null,
      couponIssuedAt: queryBuilder.couponIssuedAt ? format(queryBuilder.couponIssuedAt, DateFormatStr) : null,
    };
  }

  /**
   * CS 재전송.
   *
   * 비관적 락(SELECT FOR UPDATE)으로 동시 재발송 race 차단:
   * - 첫 번째 요청: 락 획득 → oneSend 수행 → status 변경 → 커밋 → 락 해제
   * - 두 번째 요청: 락 대기 → 획득 후 status 확인 → 재발송 대상 아닌 상태로 변했거나
   *   여전히 대상이지만 oneSend 내부 reverseRefundForResend/refundForFail은 이미
   *   처리되어 ledger 멱등 락에 의해 차단된다.
   * partner_company_extern_history.service.resendFailedDelivery 와 동일 패턴.
   */
  @Transactional()
  async reSend(user: ILoginUserInfo, getBody: CustomerServiceReSendReqDto) {
    const { orderDeliveryId } = getBody;

    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .setLock('pessimistic_write')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'company')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.brand', 'choiceSelectBrand')
      .andWhere('orderDelivery.status IN (:...status)', { status: ['COMPLETE', 'FAIL', 'COMPLETE_SMS', 'FAIL_SMS'] })
      .andWhere('orderDelivery.id = :orderDeliveryId', { orderDeliveryId: orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new BadRequestException('주문 발송가 존재하지 않습니다.');
    }

    // 권한검사: 쿠폰 종류(일반/SSG)에 맞는 CS 권한 (getList 분류 기준과 동일, 그 외 타입은 거부)
    const requiredAuth = this.resolveCsCouponAuthority(orderDelivery.orderProductMapping?.product?.type);
    if (!requiredAuth) {
      throw new BadRequestException('CS 대상이 아닌 상품 유형입니다.');
    }
    await this.authService.authorityValidator(user, requiredAuth);

    if (orderDelivery.deliveryTarget === '-') {
      throw new BadRequestException('파기된 발송 정보입니다.');
    }

    await this.deliveryBatchService.oneSend(orderDelivery);
  }

  /**
   * 폐기 실행 (외부 API 호출 + 상태 변경 + 잔액 복구)
   * historyData가 전달되면 Tx1 안에서 history도 기록
   *
   * 트랜잭션 분리:
   * - Tx1: couponStatus / discardedAt / (옵션) historyData → 무조건 commit 필요
   * - Tx2: 환불 처리 (restoreBalanceOnDiscard) → 실패 허용
   *
   * 사유: 외부 cancel 성공 후 환불 단계 실패 시, 폐기 사실이 DB에 반영되지 않으면
   * 사용자는 쿠폰이 여전히 활성 상태로 인지하게 되고, 갤럭시아 측은 이미 CANCEL이라
   * 재시도 시 "이미 취소됨" 응답을 받게 됨. 폐기 사실은 항상 저장하고,
   * 환불 실패는 별도 신호로 caller가 처리하도록 한다.
   */
  private async execDiscard(
    user: ILoginUserInfo,
    orderDeliveryId: number,
    couponStatus: OrderDeliveryCouponStatus,
    historyData?: { type: string; content: string },
    options?: { skipBalanceRestore?: boolean },
  ): Promise<{
    orderDelivery: OrderDeliveryEntity;
    beforeChange: string;
    refundStatus: 'SUCCESS' | 'FAILED' | 'SKIPPED';
    refundError?: Error;
    destroyAmount: number | null;
    restoreAmount: number | null;
  }> {
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

    // 폐기 대상 정산금액(할인가 기준) — 이력 행별 폐기금액으로 기록
    const destroyAmount = calculateSettlementPrice(
      orderDelivery.orderProductMapping,
      orderDelivery.orderProductMapping.order.cardSurchargeApplied,
      orderDelivery,
    );

    // 권한검사: 폐기는 쿠폰 종류(일반/SSG)에 맞는 CS 권한을 요구 (getList 분류 기준과 동일)
    // execDiscard 를 거치는 경로(pin-discard / history 폐기류)에 일괄 적용된다.
    // (주의: bulk-discard 는 execDiscard 를 거치지 않고 자체 폐기 로직을 가지므로 별도 검사 필요)
    const requiredAuth = this.resolveCsCouponAuthority(orderDelivery.orderProductMapping?.product?.type);
    if (!requiredAuth) {
      throw new BadRequestException('폐기 대상이 아닌 상품 유형입니다.');
    }
    await this.authService.authorityValidator(user, requiredAuth);

    const partnerType = this.getPartnerType(orderDelivery);
    const beforeChange = orderDelivery.couponStatus;

    // terminal 상태(USED/CANCEL/REFUND_CANCEL)는 모든 협력사 분기 공통으로 차단 — 이미 폐기/사용된 건의 재진입 방지.
    // (EXPIRED 는 협력사=차단 / SSG=환불폐기 허용으로 분기별 별도 처리. default 분기 누락 방지를 위해 switch 앞에 둔다)
    if (
      beforeChange === OrderDeliveryCouponStatus.USED ||
      beforeChange === OrderDeliveryCouponStatus.CANCEL ||
      beforeChange === OrderDeliveryCouponStatus.REFUND_CANCEL
    ) {
      throw new BadRequestException('현재 변경을 할 수 없는 핀상태입니다.');
    }

    // 외부 API 폐기 처리 (트랜잭션 밖에서 실행)
    switch (partnerType) {
      case 'GS_M_BIZ':
      case 'GIFT_SHOW':
      case 'CULTURELAND':
      case 'GALAXIA':
      case 'GIFTIEL':
      case 'DAOU': {
        // 협력사 쿠폰은 EXPIRED(기간만료)도 폐기 불가 (terminal 공통 차단은 switch 앞에서 이미 수행)
        if (beforeChange === 'EXPIRED') {
          throw new BadRequestException('현재 변경을 할 수 없는 핀상태입니다.');
        }

        if (
          couponStatus === OrderDeliveryCouponStatus.CANCEL ||
          couponStatus === OrderDeliveryCouponStatus.REFUND_CANCEL
        ) {
          const result = await this.partnerCompanyExternService.cancel(orderDelivery);

          if (result.message !== '폐기 완료') {
            const syncedStatus = await this.syncCouponStatusAfterDiscardFailure(orderDelivery);
            const statusSuffix = syncedStatus ? ` (현재 쿠폰상태: ${syncedStatus})` : '';
            throw new InternalServerErrorException(`${result.message}${statusSuffix}`);
          }
        } else {
          throw new BadRequestException('변경을 할 수 없는 핀상태입니다.');
        }
        break;
      }
      case 'SSG': {
        // terminal 공통 차단은 switch 앞에서 수행. SSG는 EXPIRED 일 때 환불폐기(REFUND_CANCEL)만 허용
        if (beforeChange === 'EXPIRED' && couponStatus !== OrderDeliveryCouponStatus.REFUND_CANCEL) {
          throw new BadRequestException('기간만료 상태에서는 환불폐기만 가능합니다.');
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

    // Tx1: 폐기 상태 + (옵션) historyData 저장
    // 외부 cancel 이 이미 성공한 상태이므로 DB 반영 실패는 곧 상태 불일치를 의미한다.
    // Tx1 실패는 caller 에서 인지할 수 있도록 그대로 throw 한다.
    let savedHistoryId: number | null = null;
    const tx1 = this.dataSource.createQueryRunner();
    await tx1.connect();
    await tx1.startTransaction();
    try {
      // 메모리 값 갱신 (Tx2 restoreBalanceOnDiscard 등 후속 로직이 orderDelivery.couponStatus 를 읽음)
      orderDelivery.couponStatus = couponStatus;
      orderDelivery.discardedAt = new Date();

      // 상태 전이는 조건부 UPDATE(CAS)로 저장 — coupon_status 가 아직 beforeChange 일 때만 반영.
      // 동시 폐기 요청 시 둘 다 save 로 덮어쓰는 레이스를 affected=0 으로 감지·차단(멱등).
      // (코드베이스 관례: settle.service 상태전이, ssg-insert-state.markAttempted 와 동일 패턴)
      const transition = await tx1.manager
        .createQueryBuilder()
        .update(OrderDeliveryEntity)
        .set({ couponStatus, discardedAt: orderDelivery.discardedAt })
        .where('id = :id AND coupon_status = :before', { id: orderDelivery.id, before: beforeChange })
        .execute();

      if (transition.affected === 0) {
        // 다른 요청이 먼저 폐기를 반영함 → 늦은 요청은 중복 처리 차단
        throw new BadRequestException('이미 폐기 처리된 발송입니다.');
      }

      if (historyData) {
        const history = this.orderHistoryRepository.create({
          orderDeliveryId: orderDelivery.id,
          userId: user.id,
          type: historyData.type,
          content: historyData.content,
          beforeChange,
          afterChange: orderDelivery.couponStatus,
          destroyAmount,
        });
        const saved = await tx1.manager.save(OrderHistoryEntity, history);
        savedHistoryId = saved.id;
      }

      await tx1.commitTransaction();
    } catch (error) {
      await tx1.rollbackTransaction();
      throw error;
    } finally {
      await tx1.release();
    }

    // Tx2: 예치금/여신 복구 (실패 허용)
    // 폐기 후 신규 발송 시에는 스킵 — 핀 교체이므로 잔액 변동 없음
    let refundStatus: 'SUCCESS' | 'FAILED' | 'SKIPPED' = 'SKIPPED';
    let refundError: Error | undefined;
    let restoreAmount: number | null = null;

    if (!options?.skipBalanceRestore) {
      const tx2 = this.dataSource.createQueryRunner();
      await tx2.connect();
      await tx2.startTransaction();
      try {
        restoreAmount = await this.restoreBalanceOnDiscard(orderDelivery, user, tx2);
        await tx2.commitTransaction();
        refundStatus = 'SUCCESS';
      } catch (error) {
        await tx2.rollbackTransaction();
        refundStatus = 'FAILED';
        refundError = error instanceof Error ? error : new Error(String(error));
        this.logger.error(
          `[execDiscard] 폐기는 완료(orderDeliveryId=${orderDelivery.id})되었으나 환불 처리 실패: ${refundError.message}`,
          refundError.stack,
        );
      } finally {
        await tx2.release();
      }
    }

    // pinDiscard 등 Tx1 에서 이미 history 를 기록한 경로: 복원액은 Tx2 후 확정되므로 보강 update
    if (savedHistoryId !== null && restoreAmount !== null) {
      await this.orderHistoryRepository.update(savedHistoryId, { restoreAmount });
    }

    return { orderDelivery, beforeChange, refundStatus, refundError, destroyAmount, restoreAmount };
  }

  /**
   * 폐기 역전 (폐기 후 신규 발송 롤백용). CAS: 아직 CANCEL 일 때만 originalStatus 로 되돌리고 discardedAt 해제.
   * SSG 폐기는 외부 cancel 을 호출하지 않으므로(SsgDB 미터치) 상태 플립만으로 안전하게 원복된다.
   */
  private async reverseDiscard(
    orderDeliveryId: number,
    originalStatus: OrderDeliveryCouponStatus,
  ): Promise<void> {
    await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ couponStatus: originalStatus, discardedAt: null })
      .where('id = :id AND coupon_status = :cancel', {
        id: orderDeliveryId,
        cancel: OrderDeliveryCouponStatus.CANCEL,
      })
      .execute();
  }

  /**
   * 핀폐기 API (직접 호출용) — 폐기 실행 + history 기록
   * 환불 실패 시 폐기 사실은 이미 저장된 상태로 명시적 에러 메시지를 반환한다.
   */
  async pinDiscard(user: ILoginUserInfo, getBody: CustomerServiceDiscardReqDto) {
    const result = await this.execDiscard(user, getBody.orderDeliveryId, getBody.couponStatus, {
      type: '폐기',
      content: '핀폐기 처리',
    });

    if (result.refundStatus === 'FAILED') {
      throw new InternalServerErrorException(
        `폐기는 완료되었으나 환불 처리 중 오류가 발생했습니다. 운영팀에 문의해주세요. (${result.refundError?.message ?? 'unknown'})`,
      );
    }
  }

  async refreshCoupon(user: ILoginUserInfo, getQuery: CustomerServiceCouponRefreshReqDto) {
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

    // 권한검사: 쿠폰 종류(일반/SSG)에 맞는 CS 권한 (getList 분류 기준과 동일, 그 외 타입은 거부)
    const requiredAuth = this.resolveCsCouponAuthority(orderDelivery.orderProductMapping?.product?.type);
    if (!requiredAuth) {
      throw new BadRequestException('CS 대상이 아닌 상품 유형입니다.');
    }
    await this.authService.authorityValidator(user, requiredAuth);

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
      // 초이스쿠폰은 선택 상품의 협력사가 실제 PIN 발행처 → choice 우선(외부 cancel/getPartnerType 과 동일 기준).
      // 원상품만 보면 choice 발행처와 다른 분기로 라우팅돼 외부 cancel 없이 내부 상태만 바뀔 수 있음.
      businessName: (
        orderDelivery.choiceSelectProduct?.partnerCompany ?? orderDelivery.orderProductMapping?.product?.partnerCompany
      )?.businessName,
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
  /**
   * 핀상태 상태 전이 저장 — 조건부 UPDATE(CAS) + (옵션) 이력을 한 트랜잭션으로.
   *
   * - CAS: coupon_status 가 아직 beforeChange 일 때만 반영. 동시 요청이 save 로 서로 덮어쓰는
   *   레이스(예: REFUND_CANCEL 을 CANCEL 로 둔갑)를 affected=0 으로 감지·차단(멱등).
   * - 상태 전이와 이력을 한 트랜잭션으로 묶어 "상태만 바뀌고 이력 누락" 부분완료를 방지.
   * - 폐기 execDiscard Tx1(상태 전이 CAS + history) 과 동일 패턴.
   *   (외부 협력사 cancel 은 호출자가 트랜잭션 밖에서 선행 — HTTP 는 롤백 불가)
   */
  private async commitPinStatusTransition(
    orderDeliveryId: number,
    beforeChange: string,
    set: { couponStatus: OrderDeliveryCouponStatus; discardedAt?: Date },
    history?: { userId: number; type: string; content: string; afterChange: OrderDeliveryCouponStatus },
  ): Promise<void> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const transition = await qr.manager
        .createQueryBuilder()
        .update(OrderDeliveryEntity)
        .set(set)
        .where('id = :id AND coupon_status = :before', { id: orderDeliveryId, before: beforeChange })
        .execute();

      if (transition.affected === 0) {
        // 다른 요청이 먼저 상태를 바꿈 → 늦은 요청은 덮어쓰지 않고 멱등 차단
        throw new BadRequestException('이미 처리되어 변경할 수 없는 핀상태입니다.');
      }

      if (history) {
        const historyEntity = this.orderHistoryRepository.create({
          orderDeliveryId,
          userId: history.userId,
          type: history.type,
          content: history.content,
          beforeChange,
          afterChange: history.afterChange,
        });
        await qr.manager.save(OrderHistoryEntity, historyEntity);
      }

      await qr.commitTransaction();
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }

  async execPinStatusModify(map: any) {
    const { businessName, beforeChange, afterChange, type, content, orderDelivery } = map;

    // [공통 terminal 가드] 끝난 상태(USED/CANCEL/REFUND_CANCEL)는 어떤 협력사 분기든 재진입 금지.
    // switch 앞에 두어 default 분기까지 전 경로를 덮는다 — 분기별 가드의 누락(REFUND_CANCEL 등)을 봉합.
    // (EXPIRED 는 협력사=차단 / SSG=현행 보존으로 분기별 별도 처리. 폐기 execDiscard 와 동일 패턴)
    if (
      beforeChange === OrderDeliveryCouponStatus.USED ||
      beforeChange === OrderDeliveryCouponStatus.CANCEL ||
      beforeChange === OrderDeliveryCouponStatus.REFUND_CANCEL
    ) {
      throw new BadRequestException('현재 변경을 할 수 없는 핀상태입니다.');
    }

    switch (businessName) {
      case 'GS엠비즈':
      case '대홍기획':
      case '컬쳐랜드':
      case '갤럭시아':
      case '케이티알파':
      case '주식회사 다우기술':
        // 협력사 쿠폰은 기간만료(EXPIRED)도 변경 불가 (terminal 공통 차단은 switch 앞에서 수행)
        if (beforeChange === OrderDeliveryCouponStatus.EXPIRED) {
          throw new BadRequestException('현재 변경을 할 수 없는 핀상태입니다.');
        }

        if (afterChange === 'CANCEL' || afterChange === 'REFUND_CANCEL') {
          // 외부 cancel 은 트랜잭션 밖에서 선행(HTTP 롤백 불가). 성공 응답 후에만 DB 반영.
          const result = await this.partnerCompanyExternService.cancel(orderDelivery);

          if (result.message === '폐기 완료') {
            await this.commitPinStatusTransition(
              orderDelivery.id,
              beforeChange,
              { couponStatus: OrderDeliveryCouponStatus.CANCEL, discardedAt: new Date() },
              { userId: map.userId, type, content, afterChange: OrderDeliveryCouponStatus.CANCEL },
            );
          } else {
            throw new InternalServerErrorException(result.message);
          }
        } else {
          throw new BadRequestException('변경을 할 수 없는 핀상태입니다.');
        }

        break;
      case 'SSG':
        // SSG 기간만료 정책은 현행 보존(전면 차단). 폐기(만료→환불폐기 허용)와의 비대칭은
        // 의도/누락 확인이 필요한 별도 사안 — 본 작업(가드/CAS/트랜잭션)에서 동작 변경하지 않음.
        if (beforeChange === OrderDeliveryCouponStatus.EXPIRED) {
          throw new BadRequestException('현재 변경을 할 수 없는 핀상태입니다.');
        }

        if (afterChange === 'CANCEL' || afterChange === 'REFUND_CANCEL') {
          await this.commitPinStatusTransition(
            orderDelivery.id,
            beforeChange,
            { couponStatus: afterChange, discardedAt: new Date() },
            { userId: orderDelivery.userId, type, content, afterChange },
          );
        } else {
          throw new BadRequestException('변경을 할 수 없는 핀상태입니다.');
        }

        break;
      default:
        // 협력사 미지정 등 — 상태만 보정(이력 없음). 허용 상태(CANCEL/REFUND_CANCEL)만 명시 제한:
        // DTO @IsEnum 1차 차단 + 여기서 폐기/환불폐기로 2차 제한 → 임의 문자열의 상태 컬럼 오염 방지.
        if (afterChange !== 'CANCEL' && afterChange !== 'REFUND_CANCEL') {
          throw new BadRequestException('변경을 할 수 없는 핀상태입니다.');
        }
        // 경합 방지를 위해 CAS 적용.
        await this.commitPinStatusTransition(orderDelivery.id, beforeChange, { couponStatus: afterChange });
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
    switch (getBody.type) {
      case '재전송': {
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
      case '폐기 후 신규 발송': {
        // beforeChange와 afterChange는 execHistory case 블록에서 설정됨
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
        case 'alimtalk':
          sendMethod = '알림톡';
          break;
        case 'email':
          sendMethod = '이메일';
          break;
      }
    } else if (
      getBody.type === '수신정보 변경요청' ||
      getBody.type === '폐기 후 신규 발송'
    ) {
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
    };
  }

  /**
   * CS 등록 API 서비스실행
   * @param map
   */
  async execHistory(map: any) {
    let afterChange = '';
    let pendingRefundError: Error | null = null;
    let discardDestroyAmount: number | null = null;
    let discardRestoreAmount: number | null = null;

    switch (map.type) {
      case '단순문의': {
        break;
      }
      case '재전송': {
        switch (map.extraType) {
          case 'sms': {
            await this.deliveryBatchService.csResendAsSms(map.orderDeliveryId);
            break;
          }
          case 'forced_mms': {
            await this.deliveryBatchService.csResendAsMms(map.orderDeliveryId);
            break;
          }
          case 'alimtalk': {
            await this.deliveryBatchService.csResendAsAlimTalk(map.orderDeliveryId);
            break;
          }
          case 'email': {
            await this.deliveryBatchService.csResendAsEmail(map.orderDeliveryId);
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

        await this.reSend(map.user, resendDto);

        afterChange = encryptedNewTarget;
        break;
      }
      case '폐기 후 신규 발송': {
        const newTarget = map.afterChange;
        const orderDelivery = map.orderDelivery as OrderDeliveryEntity;

        if (orderDelivery.deliveryMethod === IOrderSendMethod.EMAIL) {
          if (!PhoneUtil.isValidEmail(newTarget)) {
            throw new BadRequestException('유효하지 않은 이메일 주소입니다.');
          }
        } else {
          if (!PhoneUtil.isValidPhone(newTarget)) {
            throw new BadRequestException('유효하지 않은 전화번호입니다.');
          }
        }

        const isSsg = orderDelivery.orderProductMapping.order.type === IOrderType.SSG;
        const reissuePrice = orderDelivery.orderProductMapping.product.price;
        const reissueExpireDay = orderDelivery.orderProductMapping.product.expireDay;
        const reissueOrderId = orderDelivery.orderProductMapping.order.id;

        // SSG: 폐기 전에 발급가능 행사 확보(fail-fast). 없으면 폐기조차 안 함.
        let reissueEvent: SsgEventEntity | null = null;
        let resendDeductionId: string | null = null;
        if (isSsg) {
          const acquired = await this.deliveryBatchService.selectAndDeductSsgEventForReissue(
            reissueOrderId,
            reissuePrice,
            reissueExpireDay,
          );
          if (!acquired) {
            throw new BadRequestException('발급 가능한 행사가 없습니다. (행사 잔액 부족)');
          }
          reissueEvent = acquired.event;
          resendDeductionId = acquired.resendDeductionId;
        }

        // 폐기 — 잔액 복구 스킵(핀 교체, SSG는 forfeit)
        let discardedDelivery: OrderDeliveryEntity;
        let discardBefore: OrderDeliveryCouponStatus;
        try {
          const discardResult = await this.execDiscard(
            map.user,
            map.orderDeliveryId,
            OrderDeliveryCouponStatus.CANCEL,
            undefined,
            { skipBalanceRestore: true },
          );
          discardedDelivery = discardResult.orderDelivery;
          discardBefore = discardResult.beforeChange as OrderDeliveryCouponStatus;
        } catch (e) {
          if (isSsg && reissueEvent && resendDeductionId) {
            await this.deliveryBatchService.reverseSsgReissueDeduct(
              orderDelivery, reissueEvent.id, reissuePrice, reissueOrderId, resendDeductionId,
            );
          }
          throw e;
        }

        const decryptedOldTarget = this.cryptoCipher.safeDecryptDeliveryTarget(discardedDelivery.deliveryTarget);
        const oldPin = discardedDelivery.barCode || '';
        map.beforeChange = `${decryptedOldTarget} / ${oldPin}`;

        // MEDIUM-2: discardBefore 캐스트 검증 — 잘못된 값이 reverseDiscard 로 전파되지 않도록 방어
        const discardBeforeValidated = Object.values(OrderDeliveryCouponStatus).includes(discardBefore)
          ? discardBefore
          : null;
        if (!discardBeforeValidated) {
          this.logger.error(
            `[폐기후신규발송] discardBefore 가 유효하지 않은 값(${discardBefore}) — reverseDiscard 생략`,
          );
        }

        /**
         * SSG 선차감+폐기 완전 역전 헬퍼.
         * issue() 호출 전(미등록 확정) 구간에서 공유. 실패는 최선 처리로 로깅만.
         * @param od - issue() 전 단계라면 fullDelivery 아직 없을 수 있으므로 orderDelivery 사용
         * @param savedId - 이미 save 한 newDelivery 의 id (없으면 null)
         */
        const unwindReissue = async (
          od: OrderDeliveryEntity,
          savedId: number | null,
          outcome: SsgRefundOutcome,
        ): Promise<void> => {
          // 1) 폐기 역전(고객 쿠폰 복구) — 먼저
          if (discardBeforeValidated) {
            try {
              await this.reverseDiscard(discardedDelivery.id, discardBeforeValidated);
            } catch (rdErr) {
              this.logger.error(
                `[폐기후신규발송] reverseDiscard 실패(outcome=${outcome}) — orderDeliveryId=${discardedDelivery.id}`,
                rdErr,
              );
            }
          }
          // 2) 신규 row soft-delete — 나중에
          if (savedId != null) {
            try {
              await this.orderDeliveryRepository.softDelete(savedId);
            } catch (sdErr) {
              this.logger.error(
                `[폐기후신규발송] softDelete 실패(outcome=${outcome}) — orderDeliveryId=${savedId}`,
                sdErr,
              );
            }
          }
        };

        const newDelivery = new OrderDeliveryEntity();
        newDelivery.orderProductMappingId = discardedDelivery.orderProductMappingId;
        newDelivery.status = IOrderDeliveryStatus.WAIT;
        newDelivery.deliveryMethod = discardedDelivery.deliveryMethod;

        const normalizedTarget = PhoneUtil.normalizeDeliveryTarget(newTarget);
        const encryptedTarget = this.cryptoCipher.encryptDeliveryTarget(normalizedTarget);
        newDelivery.deliveryTarget = encryptedTarget;
        newDelivery.originalDeliveryTarget = encryptedTarget;
        newDelivery.sendRequestAt = new Date();
        newDelivery.transactionId = randomUUID();
        newDelivery.replaceCharacter1 = discardedDelivery.replaceCharacter1;
        newDelivery.replaceCharacter2 = discardedDelivery.replaceCharacter2;
        newDelivery.replaceCharacter3 = discardedDelivery.replaceCharacter3;
        newDelivery.replacedFromId = discardedDelivery.id;
        newDelivery.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
        // 원본 정산 조건 보존 (SSG 중복할인 등 delivery 레벨 fee/adjustment)
        newDelivery.settleFee = discardedDelivery.settleFee;
        newDelivery.settlePriceAdjustment = discardedDelivery.settlePriceAdjustment;

        if (discardedDelivery.emailReceiverPhone) {
          newDelivery.emailReceiverPhone = discardedDelivery.emailReceiverPhone;
        }
        // SSG: 새로 확보한 행사로 발급(동일 행사일 수도, 다른 행사일 수도). 비SSG: 기존 값 승계.
        if (isSsg && reissueEvent) {
          newDelivery.ssgEventId = reissueEvent.id;
        } else if (discardedDelivery.ssgEventId) {
          newDelivery.ssgEventId = discardedDelivery.ssgEventId;
        }
        if (discardedDelivery.choiceSelectProductId) {
          newDelivery.choiceSelectProductId = discardedDelivery.choiceSelectProductId;
        }

        // CRITICAL: save/findOne 실패 시에도 SSG 선차감·폐기를 역전해야 한다 (issue 미실행 → 미등록 확정)
        let savedDelivery: OrderDeliveryEntity | undefined;
        let fullDelivery: OrderDeliveryEntity | null;
        try {
          savedDelivery = await this.orderDeliveryRepository.save(newDelivery);

          // oneSend() 사용 금지: reverseRefundForResend() 이중 차감 버그
          fullDelivery = await this.orderDeliveryRepository.findOne({
            where: { id: savedDelivery.id },
            relations: [
              'orderProductMapping',
              'orderProductMapping.product',
              'orderProductMapping.product.partnerCompany',
              'orderProductMapping.product.brand',
              'orderProductMapping.order',
              'choiceSelectProduct',
              'choiceSelectProduct.partnerCompany',
              'ssgEvent',
            ],
          });

          if (!fullDelivery) {
            throw new InternalServerErrorException('새 발송 건 조회에 실패했습니다.');
          }
        } catch (preIssueErr) {
          if (isSsg && reissueEvent && resendDeductionId) {
            await this.deliveryBatchService.reverseSsgReissueDeduct(
              orderDelivery, reissueEvent.id, reissuePrice, reissueOrderId, resendDeductionId,
            );
            await unwindReissue(orderDelivery, savedDelivery?.id ?? null, SsgRefundOutcome.RESTORED);
          }
          throw preIssueErr;
        }

        const ssgEvent = fullDelivery.ssgEvent ?? null;

        // PIN 발급 — 실패 시 SSG 선차감 역복원 + (미등록 확정이면) 폐기 역전·새 delivery 제거
        try {
          await this.partnerCompanyExternService.issue(fullDelivery, ssgEvent);
        } catch (issueError) {
          if (isSsg && reissueEvent && resendDeductionId) {
            const outcome = await this.deliveryBatchService.reverseSsgReissueDeduct(
              fullDelivery, reissueEvent.id, reissuePrice, reissueOrderId, resendDeductionId,
            );
            if (outcome === SsgRefundOutcome.RESTORED) {
              await unwindReissue(fullDelivery, savedDelivery.id, outcome);
              throw new InternalServerErrorException('신규 발송에 실패하여 폐기를 취소했습니다. 다시 시도해 주세요.');
            }
            this.logger.error(
              `[폐기후신규발송] issue 실패하나 SSG 등록 불명/확정(outcome=${outcome}) — 폐기 유지. orderDeliveryId=${savedDelivery.id}`,
            );
            throw new InternalServerErrorException(
              '신규 발송 처리 중 오류가 발생했습니다. 발송실패내역에서 상태를 확인해 주세요.',
            );
          }
          throw issueError;
        }

        // 폐기 후 신규발송: 새 쿠폰이므로 유효기간 새로 계산 (SSG는 issue() 내부에서 expireAt 채움 → 제외)
        if (fullDelivery.orderProductMapping.order.type !== IOrderType.SSG) {
          const opm = fullDelivery.orderProductMapping;
          const expireDays = resolveExpireDays(
            opm.galaxiaDuration ?? opm.product.galaxiaDuration,
            opm.product.expireDay,
            opm.product.partnerCompany?.validityStartsNextDay,
          );
          fullDelivery.expireAt = addDays(new Date(), expireDays);
          if (opm.encourageDay) {
            fullDelivery.encourageAt = subDays(fullDelivery.expireAt, opm.encourageDay);
          }
        }

        await this.orderDeliveryRepository.save(fullDelivery);

        // HIGH-2: issue() 성공 후 barCode 없음 — SSG 는 outcome 으로 분기, 비SSG 는 단순 throw
        if (!fullDelivery.barCode) {
          if (isSsg && reissueEvent && resendDeductionId) {
            const outcome = await this.deliveryBatchService.reverseSsgReissueDeduct(
              fullDelivery, reissueEvent.id, reissuePrice, reissueOrderId, resendDeductionId,
            );
            if (outcome === SsgRefundOutcome.RESTORED) {
              await unwindReissue(fullDelivery, savedDelivery.id, outcome);
              throw new InternalServerErrorException('신규 발송에 실패하여 폐기를 취소했습니다. 다시 시도해 주세요.');
            }
            this.logger.error(
              `[폐기후신규발송] barCode 누락 + SSG 등록 불명/확정(outcome=${outcome}) — 폐기 유지. orderDeliveryId=${savedDelivery.id}`,
            );
            throw new InternalServerErrorException(
              '신규 발송 처리 중 오류가 발생했습니다. 발송실패내역에서 상태를 확인해 주세요.',
            );
          }
          throw new InternalServerErrorException('핀 발급에 실패했습니다.');
        }

        const newPin = fullDelivery.barCode;
        afterChange = `${normalizedTarget} / ${newPin}`;

        // 발송 시도 — 실패해도 history는 OLD/NEW 양쪽에 기록
        let sendStatus: IOrderDeliveryStatus = IOrderDeliveryStatus.COMPLETE;
        let sendError: unknown = null;
        try {
          switch (fullDelivery.deliveryMethod) {
            case IOrderSendMethod.ALIM_TALK:
              sendStatus = await this.deliveryBatchService.csResendAsAlimTalk(savedDelivery.id);
              break;
            case IOrderSendMethod.MMS:
              await this.deliveryBatchService.csResendAsMms(savedDelivery.id);
              break;
            case IOrderSendMethod.EMAIL:
              await this.deliveryBatchService.csResendAsEmail(savedDelivery.id);
              break;
            default:
              await this.deliveryBatchService.csResendAsSms(savedDelivery.id);
              break;
          }
        } catch (e) {
          sendError = e;
          sendStatus = IOrderDeliveryStatus.FAIL_SMS;
        }

        fullDelivery.status = sendStatus;
        if (sendStatus === IOrderDeliveryStatus.COMPLETE || sendStatus === IOrderDeliveryStatus.COMPLETE_SMS) {
          fullDelivery.actualSendAt = new Date();
        } else {
          fullDelivery.failedAt = new Date();
        }
        await this.orderDeliveryRepository.save(fullDelivery);

        // history 양쪽(OLD/NEW)에 기록 — 발송 실패 여부와 무관하게 보장
        const sharedHistoryFields = {
          userId: map.userId,
          type: map.type,
          content: map.content,
          sendMethod: map.sendMethod,
          beforeChange: map.beforeChange,
          afterChange: afterChange,
        };
        await this.orderHistoryRepository.save([
          this.orderHistoryRepository.create({
            ...sharedHistoryFields,
            orderDeliveryId: map.orderDelivery.id,
          }),
          this.orderHistoryRepository.create({
            ...sharedHistoryFields,
            orderDeliveryId: savedDelivery.id,
          }),
        ]);

        if (sendError) {
          throw new InternalServerErrorException(
            `신규 PIN ${newPin}이(가) 발급되었으나 발송에 실패했습니다. 발송실패내역에서 재발송해 주세요.`,
          );
        }

        return;
      }
      case '폐기': {
        const result = await this.execDiscard(map.user, map.orderDeliveryId, OrderDeliveryCouponStatus.CANCEL);
        afterChange = result.orderDelivery.couponStatus;
        discardDestroyAmount = result.destroyAmount;
        discardRestoreAmount = result.restoreAmount;
        if (result.refundStatus === 'FAILED' && result.refundError) {
          pendingRefundError = result.refundError;
        }
        break;
      }
      case '환불폐기': {
        const result = await this.execDiscard(map.user, map.orderDeliveryId, OrderDeliveryCouponStatus.REFUND_CANCEL);
        afterChange = result.orderDelivery.couponStatus;
        discardDestroyAmount = result.destroyAmount;
        discardRestoreAmount = result.restoreAmount;
        if (result.refundStatus === 'FAILED' && result.refundError) {
          pendingRefundError = result.refundError;
        }
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
      destroyAmount: discardDestroyAmount,
      restoreAmount: discardRestoreAmount,
    });

    await this.orderHistoryRepository.save(history);

    // 환불 실패는 폐기 상태/이력 저장 이후에 명시적으로 통보한다.
    // 사용자에게 "폐기 자체는 완료되었음"을 응답 메시지로 알려서 동일 발송건의 무의미한 재시도를 막는다.
    if (pendingRefundError) {
      throw new InternalServerErrorException(
        `폐기는 완료되었으나 환불 처리 중 오류가 발생했습니다. 운영팀에 문의해주세요. (${pendingRefundError.message})`,
      );
    }
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
  async mapStatusList(user: ILoginUserInfo, getQuery: CustomerServiceStatusListReqDto) {
    // 권한검사: 변경내역은 발송건(orderDeliveryId)에 종속되므로, 해당 발송의 쿠폰 종류 권한을 요구
    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: { id: getQuery.orderDeliveryId },
      relations: ['orderProductMapping', 'orderProductMapping.product'],
    });
    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 발송 정보입니다.');
    }
    const requiredAuth = this.resolveCsCouponAuthority(orderDelivery.orderProductMapping?.product?.type);
    if (!requiredAuth) {
      throw new BadRequestException('CS 대상이 아닌 상품 유형입니다.');
    }
    await this.authService.authorityValidator(user, requiredAuth);

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
          destroyAmount: h.destroyAmount ?? null,
          restoreAmount: h.restoreAmount ?? null,
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
  async getUnmaskedDeliveryTarget(user: ILoginUserInfo, getQuery: CustomerServiceUnmaskedDeliveryTargetReqDto) {
    const { orderDeliveryId } = getQuery;

    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: {
        id: orderDeliveryId,
        deletedAt: IsNull(),
      },
      relations: ['orderProductMapping', 'orderProductMapping.product'],
    });

    if (!orderDelivery) {
      throw new NotFoundException('존재하지 않는 발송 정보입니다.');
    }

    // 권한검사: 복호화된 수신정보(개인정보)를 반환하므로, 쿠폰 종류(일반/SSG)에 맞는 CS 권한을 요구
    // (getList 분류 기준과 동일, 그 외 타입은 거부)
    const requiredAuth = this.resolveCsCouponAuthority(orderDelivery.orderProductMapping?.product?.type);
    if (!requiredAuth) {
      throw new BadRequestException('CS 대상이 아닌 상품 유형입니다.');
    }
    await this.authService.authorityValidator(user, requiredAuth);

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
   * 초이스쿠폰의 경우 선택한 상품의 협력사 type을 우선 반환.
   */
  private getPartnerType(orderDelivery: OrderDeliveryEntity): IPartnerCompanyType | null | undefined {
    return (
      orderDelivery.choiceSelectProduct?.partnerCompany?.type ??
      orderDelivery.orderProductMapping?.product?.partnerCompany?.type
    );
  }

  /**
   * 쿠폰 종류(product.type)에 맞는 CS 권한을 반환한다. (getList 분류 기준과 동일)
   * - SSG → CUSTOMER_SSG_COUPON
   * - GENERAL / CHOICE → CUSTOMER_GENERAL_COUPON
   * - 그 외(DELIVERY/SELF/REAL 등)는 CS 폐기 대상이 아니므로 null (호출측이 거부/skip 처리)
   */
  private resolveCsCouponAuthority(productType?: IProductType): UserAuthSubEnum | null {
    if (productType === IProductType.SSG) {
      return UserAuthSubEnum.CUSTOMER_SSG_COUPON;
    }
    if (productType === IProductType.GENERAL || productType === IProductType.CHOICE) {
      return UserAuthSubEnum.CUSTOMER_GENERAL_COUPON;
    }
    return null;
  }

  /**
   * 폐기 실패 시 협력사 check API로 쿠폰 상태를 재동기화.
   * SSG는 기존 로직 유지(외부 check 없음)이며, 그 외 협력사는 refreshCouponStatus()로
   * couponStatus / tradeAt / tradePlace를 실제 상태에 맞게 업데이트한다.
   * 동기화 자체가 실패하면 null 반환(호출측은 기존 실패 처리 유지).
   */
  private async syncCouponStatusAfterDiscardFailure(
    orderDelivery: OrderDeliveryEntity,
  ): Promise<OrderDeliveryCouponStatus | null> {
    if (this.getPartnerType(orderDelivery) === IPartnerCompanyType.SSG) {
      return null;
    }

    try {
      const updated = await this.partnerCompanyExternService.refreshCouponStatus(orderDelivery);
      return updated.couponStatus;
    } catch (error) {
      this.logger.warn(
        `폐기 실패 후 쿠폰 상태 재동기화 실패 (orderDeliveryId: ${orderDelivery.id}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
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
  ): Promise<{
    success: number[];
    failed: { id: number; reason: string; syncedStatus?: OrderDeliveryCouponStatus }[];
  }> {
    const success: number[] = [];
    const failed: { id: number; reason: string; syncedStatus?: OrderDeliveryCouponStatus }[] = [];

    // operator personName을 루프 밖에서 1회 조회
    const operatorEntity = await this.userRepository.findOne({ where: { id: user.id } });
    const operatorName = operatorEntity?.personName ?? user.email;

    // 권한 목록도 루프 밖에서 1회 계산 (건별 product.type 에 따라 메모리에서 비교 — N회 DB 조회 방지)
    const userAuthList = operatorEntity
      ? UserAuthListDefault(operatorEntity.authority, operatorEntity.authorityList)
      : [];

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

          // 1-2. 권한검사: 쿠폰 종류(일반/SSG)에 맞는 CS 권한 확인 (건별 — 혼합 건은 권한 없는 건만 skip)
          // getList 분류 기준과 동일: SSG→SSG, GENERAL/CHOICE→일반, 그 외(DELIVERY/SELF/REAL)는 대상 아님
          const requiredAuth = this.resolveCsCouponAuthority(orderDelivery.orderProductMapping?.product?.type);
          if (!requiredAuth) {
            failed.push({ id: orderDeliveryId, reason: '폐기 대상이 아닌 상품 유형입니다.' });
            continue;
          }
          if (!userAuthList.includes(requiredAuth)) {
            failed.push({ id: orderDeliveryId, reason: '해당 쿠폰 종류에 대한 폐기 권한이 없습니다.' });
            continue;
          }

          // 2. 현재 핀 상태 확인 - 이미 폐기된 경우 스킵
          if (
            orderDelivery.couponStatus === OrderDeliveryCouponStatus.CANCEL ||
            orderDelivery.couponStatus === OrderDeliveryCouponStatus.REFUND_CANCEL
          ) {
            failed.push({
              id: orderDeliveryId,
              reason: '이미 폐기된 상태입니다.',
              syncedStatus: orderDelivery.couponStatus,
            });
            continue;
          }

          // 3. 교환 또는 기간만료 상태인 경우 폐기 불가
          if (
            orderDelivery.couponStatus === OrderDeliveryCouponStatus.USED ||
            orderDelivery.couponStatus === OrderDeliveryCouponStatus.EXPIRED
          ) {
            failed.push({
              id: orderDeliveryId,
              reason: '교환 또는 기간만료 상태는 폐기할 수 없습니다.',
              syncedStatus: orderDelivery.couponStatus,
            });
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
                const syncedStatus = await this.syncCouponStatusAfterDiscardFailure(orderDelivery);
                failed.push({
                  id: orderDeliveryId,
                  reason: result.message || '외부 API 폐기 실패',
                  syncedStatus: syncedStatus ?? undefined,
                });
                continue;
              }
              orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
              orderDelivery.discardedAt = new Date();
              break;
            }
            case 'SSG':
            default: {
              orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
              orderDelivery.discardedAt = new Date();
              break;
            }
          }

          // 5. 트랜잭션: couponStatus 저장 + 복구 + CS 히스토리 (건별 트랜잭션)
          await queryRunner.startTransaction();
          try {
            // 상태 전이는 조건부 UPDATE(CAS) — coupon_status 가 아직 beforeChange 일 때만 반영.
            // bulk 와 pin/history 폐기 경합 시 stale save 가 동시 REFUND_CANCEL 을 CANCEL 로 덮는 것을 차단(멱등).
            const transition = await queryRunner.manager
              .createQueryBuilder()
              .update(OrderDeliveryEntity)
              .set({ couponStatus: OrderDeliveryCouponStatus.CANCEL, discardedAt: orderDelivery.discardedAt })
              .where('id = :id AND coupon_status = :before', { id: orderDelivery.id, before: beforeChange })
              .execute();

            if (transition.affected === 0) {
              // 다른 요청이 먼저 상태를 바꿈 → 덮어쓰지 않고 이 건만 실패 처리(아래 catch 로 전파)
              throw new BadRequestException('동시에 상태가 변경되어 폐기하지 못했습니다.');
            }

            // 예치금/여신 복구
            const restoreAmount = await this.restoreBalanceOnDiscard(orderDelivery, user, queryRunner, operatorName);
            const destroyAmount = calculateSettlementPrice(
              orderDelivery.orderProductMapping,
              orderDelivery.orderProductMapping.order.cardSurchargeApplied,
              orderDelivery,
            );

            // CS 히스토리 저장
            const history = this.orderHistoryRepository.create({
              orderDeliveryId: orderDelivery.id,
              userId: user.id,
              type: '폐기',
              content: content,
              beforeChange: beforeChange,
              afterChange: OrderDeliveryCouponStatus.CANCEL,
              destroyAmount,
              restoreAmount,
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

  /** 엑셀 다운로드 기간 상한 가드 (최대 N년). 범위 미지정 시 통과(스트리밍이 메모리 보호). 초과 시 400. */
  private assertExcelExportRangeWithinYears(startAt?: string, endAt?: string, maxYears = 3): void {
    if (!startAt || !endAt) return;
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return;
    const limit = new Date(start);
    limit.setFullYear(limit.getFullYear() + maxYears);
    if (end > limit) {
      throw new BadRequestException(`엑셀 다운로드 기간은 최대 ${maxYears}년까지 가능합니다.`);
    }
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
      barCode,
      eventName,
    } = searchParams;

    // 1. 비밀번호 검증
    await this.activityLogService.verifyPassword(user.id, password);

    // 1-1. 기간 상한 가드 (최대 3년) — 폭탄 다운로드 입구 차단
    this.assertExcelExportRangeWithinYears(startAt, endAt);

    // 2. 데이터 조회 (스트리밍: id 페이지네이션 + 행별 commit 으로 메모리 평탄)
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
      queryBuilder.andWhere(
        '(user.companyId = :userCompanyId OR clientUser.companyId = :userCompanyId)',
        { userCompanyId },
      );
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

    // 수신정보 (전문검색 - 암호화하여 비교, 이메일쿠폰 수령 핸드폰번호도 포함)
    if (deliveryTarget) {
      const normalizedTarget = PhoneUtil.normalizeDeliveryTarget(deliveryTarget);
      const encryptedTarget = this.cryptoCipher.encryptDeliveryTarget(normalizedTarget);
      queryBuilder.andWhere(
        '(orderDelivery.deliveryTarget = :deliveryTarget OR orderDelivery.emailReceiverPhone = :deliveryTarget)',
        { deliveryTarget: encryptedTarget },
      );
    }

    if (sendTitle) {
      queryBuilder.andWhere('orderProductMapping.sendTitle LIKE :sendTitle', { sendTitle: `%${sendTitle}%` });
    }

    // 협력사 (초이스쿠폰은 partnerCompanyId=0 sentinel이므로 undefined/null만 미필터 처리)
    if (partnerCompanyId != null) {
      queryBuilder.andWhere('product.partnerCompanyId = :partnerCompanyId', { partnerCompanyId });
    }

    // 핀번호 (barCode + personalCode OR 조건 부분검색)
    if (barCode) {
      queryBuilder.andWhere(
        '(orderDelivery.barCode LIKE :barCode OR orderDelivery.personalCode LIKE :barCode)',
        { barCode: `%${barCode}%` },
      );
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
          OR orderDelivery.deliveryTarget = :encryptedKeyword
          OR orderDelivery.emailReceiverPhone = :encryptedKeyword
          OR orderDelivery.barCode LIKE :keyword
          OR orderDelivery.personalCode LIKE :keyword)`,
        { keyword: `%${keyword}%`, encryptedKeyword },
      );
    }

    // 이벤트명 (부분검색)
    if (eventName) {
      queryBuilder.andWhere('order.eventName LIKE :eventName', { eventName: `%${eventName}%` });
    }

    // 날짜 조건을 실제 발송일(actualSendAt) 기준으로 변경
    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'orderDelivery', 'actualSendAt', startAt, endAt);
    // 페이지네이션 안정성: actualSendAt 동일값 타이브레이커로 id 고정
    queryBuilder.orderBy('orderDelivery.actualSendAt', 'DESC').addOrderBy('orderDelivery.id', 'DESC');

    // 3. 엑셀 워크북 생성 (스트리밍 — 임시파일로 행별 flush)
    const sheetName = orderType === 'GENERAL' ? '일반쿠폰주문CS' : '신세계CS';
    const isSSG = orderType === 'SSG';
    const filePath = createExportTempPath('xlsx');
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath });
    const worksheet = workbook.addWorksheet(sheetName);

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
    headerRow.commit();

    // 6. 데이터 행 추가 (500건씩 페이지네이션 — 매 행 commit 으로 메모리 비움)
    const CHUNK = 500;
    let offset = 0;
    let recordCount = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const chunk = await queryBuilder.clone().skip(offset).take(CHUNK).getMany();
      if (chunk.length === 0) break;
      for (const orderDelivery of chunk) {
        const order = orderDelivery.orderProductMapping.order;
        const product = orderDelivery.orderProductMapping.product;

        // deliveryTarget 복호화 (엑셀 다운로드 시 원문 표시)
        const decryptedDeliveryTarget = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget);

        // emailReceiverPhone 복호화 (이메일 쿠폰 수령 시 입력한 핸드폰 번호)
        const decryptedEmailReceiverPhone = this.cryptoCipher.safeDecryptDeliveryTarget(
          orderDelivery.emailReceiverPhone,
        );

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

        worksheet
          .addRow({
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
          })
          .commit();
        recordCount++;
      }
      offset += CHUNK;
    }

    await worksheet.commit();
    await workbook.commit();

    // 7. Activity Log 기록
    const responseTime = Date.now() - startTime;

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

    // 8. 완성된 임시파일을 응답으로 스트리밍 후 삭제
    const nowString = format(new Date(), 'yyyyMMdd_HHmmss');
    const fileName = `${sheetName}_${nowString}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    fileStream.on('close', () => {
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) {
          this.logger.error(`엑셀 임시파일 삭제 실패: ${unlinkErr}`);
        }
      });
    });
  }

}
