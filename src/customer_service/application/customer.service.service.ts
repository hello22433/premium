import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { applyReplaceCharacters } from '../../common/utils/replace-characters.util';
import {
  CS_HISTORY_TYPE,
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
import { DataSource, IsNull, MoreThanOrEqual, QueryRunner, Repository } from 'typeorm';
import { CustomerServiceGetListResDto } from '../api/customer.service.res.dto';
import { DateFormatStr, DateEndMinuteFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { CustomerServiceViewDto } from '../api/dto/customer.service.view.dto';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { IOrderDeliveryReportState } from '../../delivery/interface/order.delivery.report.state';
import { CustomerServiceDetailViewDto } from '../api/dto/customer.service.detail.view.dto';
import { CustomerServiceDlvryDetailViewDto } from '../api/dto/customer.service.dlvry.detail.view.dto';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { DeliveryBatchService } from '../../delivery/application/delivery.batch.service';
import { RefundLedgerService } from '../../delivery/application/refund-ledger.service';
import { WalletManagedPredicate } from '../../wallet/application/wallet-managed.predicate';
import { RefundPoolService } from '../../wallet/application/refund-pool.service';
import { LegacyWalletCreditSyncService } from '../../wallet/application/legacy-wallet-credit-sync.service';
import {
  OrderDeliveryAttemptEntity,
  OrderDeliveryAttemptType,
  OrderDeliveryAttemptStatus,
} from '../../entity/order.delivery.attempt.entity';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderPaymentAllocationLineEntity } from '../../entity/order.payment.allocation.line.entity';
import { OrderPaymentRefundEventType } from '../../entity/order.payment.refund.event.entity';
import { buildDiscardRefundKey } from '../../wallet/interface/wallet-idempotency';
import { WalletResourceType } from '../../wallet/interface/wallet-resource-type';
import { OrderDeliveryRefundEntity, OrderDeliveryRefundRestoreType } from '../../entity/order.delivery.refund.entity';
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
import { assertExpireDayRangeValid, resolveExpireDays } from '../../common/utils/expire.util';
import { QueryBuilderExpireDayCondition } from '../../common/infra/query.builder.expire.day.condition';
import { addDays, subDays } from 'date-fns';
import { ActivityLogService } from 'src/activity_log/application/activity.log.service';
import { ActivityLogActionType } from 'src/activity_log/interface/activity.log.action.type';
import { ActivityLogResult } from 'src/activity_log/interface/activity.log.result';
import { UserEntity } from 'src/entity/user.entity';
import { UserCompanyEntity } from 'src/entity/user.company.entity';
import { CouponViewLogEntity } from '../../entity/coupon.view.log.entity';
import { CouponViewLogResDto } from '../api/dto/customer.service.coupon.view.log.dto';
import { calculateSettlementPrice } from '../../util/settle-fee.util';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import {
  MUTATION_CLAIM_STALE_MS,
  UNSENDABLE_COUPON_STATUSES,
} from '../../delivery/interface/order.delivery.mutation.claim';
import { randomUUID } from 'crypto';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import * as fs from 'fs';
import { createExportTempPath } from '../../util/file.util';

const dayjs = require('dayjs');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(timezone);

// CS 재전송 claim self-heal 임계(ms). 크래시로 finally 못 탄 stale claim 만 재claim 허용.
// partner_company_extern_history.service 의 RESEND_CLAIM_STALE_MS 와 동일 의미(5분).
// coupon-view 방문 로그 조회 시 응답 크기 상한(최신 N건). 전체 규모는 집계 필드로 제공한다.
const COUPON_VIEW_LOG_MAX_ITEMS = 100;
const RESEND_CLAIM_STALE_MS = 5 * 60 * 1000;

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
    private readonly legacyWalletCreditSyncService: LegacyWalletCreditSyncService,
    private readonly authService: AuthService,
    @InjectRepository(CouponViewLogEntity)
    private readonly couponViewLogRepository: Repository<CouponViewLogEntity>,
  ) {}

  /**
   * 특정 발송건(order_delivery)의 coupon-view 페이지 방문 로그를 조회한다.
   * CS 상세(일반/신세계)에서 '고객이 정말 페이지를 봤는가'를 판별하는 증거로 사용한다.
   * 방문 규모는 단일 aggregate 로 집계하고, 목록은 최신순 최대 N건만 함께 반환한다(응답 크기 상한).
   */
  async getCouponViewLog(user: ILoginUserInfo, orderDeliveryId: number): Promise<CouponViewLogResDto> {
    // 권한검사: 발송건의 쿠폰 종류(일반/SSG)에 맞는 CS 권한 (getDetail 과 동일 기준, 그 외/미존재는 거부).
    // 로그인만으로 임의 orderDeliveryId 의 IP/UA 를 조회하지 못하도록 fail-closed.
    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .leftJoinAndSelect('orderProductMapping.product', 'product')
      .withDeleted()
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 발송 정보입니다.');
    }

    const requiredAuth = this.resolveCsCouponAuthority(orderDelivery.orderProductMapping?.product?.type);
    if (!requiredAuth) {
      throw new BadRequestException('CS 대상이 아닌 상품 유형입니다.');
    }
    await this.authService.authorityValidator(user, requiredAuth);

    // 집계는 단일 aggregate 쿼리로 계산한다. 여러 쿼리를 분리하면 방문 insert 와 경쟁해
    // botCount > total / 음수 humanCount 같은 불일치가 생길 수 있으므로 한 쿼리에서 일관되게 산출한다.
    const agg = await this.couponViewLogRepository
      .createQueryBuilder('log')
      .select('COUNT(*)', 'total')
      .addSelect('COALESCE(SUM(log.is_bot), 0)', 'botCount')
      .addSelect('MIN(CASE WHEN log.is_bot = 0 THEN log.created_at END)', 'firstHumanVisitedAt')
      .addSelect('MAX(log.created_at)', 'lastVisitedAt')
      .where('log.order_delivery_id = :id', { id: orderDeliveryId })
      .getRawOne<{
        total: string | number;
        botCount: string | number;
        firstHumanVisitedAt: Date | string | null;
        lastVisitedAt: Date | string | null;
      }>();

    const total = Number(agg?.total ?? 0);
    const botCount = Number(agg?.botCount ?? 0);
    const toDisplay = (v: Date | string | null | undefined): string | null =>
      v ? format(new Date(v), DateFormatStr) : null;

    // 응답 크기 상한: 최신 MAX_ITEMS 건만 목록으로 반환(무제한 응답 방지). 집계와는 독립.
    const items = await this.couponViewLogRepository.find({
      where: { orderDeliveryId },
      order: { createdAt: 'DESC' },
      take: COUPON_VIEW_LOG_MAX_ITEMS,
    });

    return {
      total,
      humanCount: total - botCount,
      botCount,
      firstHumanVisitedAt: toDisplay(agg?.firstHumanVisitedAt),
      lastVisitedAt: toDisplay(agg?.lastVisitedAt),
      items: items.map((log) => ({
        visitedAt: format(log.createdAt, DateFormatStr),
        ipAddress: log.ipAddress,
        userAgent: log.userAgent,
        source: log.source,
        isBot: log.isBot,
      })),
    };
  }

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
    if (order.isSettleComplete) {
      restoreAmount = await this.calculateSettledDiscardRestoreAmount(orderDelivery, queryRunner);
    }

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
      // 레거시(wallet 미관리) 선입금환불분만 wallet deposit 동기화 (wallet-managed 는 wallet 경로가 처리).
      if (!isWalletManaged) {
        await this.legacyWalletCreditSyncService.syncDeposit(queryRunner.manager, {
          billingUserId,
          orderId: order.id,
          orderDeliveryId: orderDelivery.id,
          delta: restoreAmount,
          type: 'DISCARD_REFUND',
          idempotencyKey: `legacy_discard_refund:${order.id}:${orderDelivery.id}:deposit`,
          memo: `레거시 선입금환불 (주문번호: ${order.id})`,
        });
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
      // 레거시(allocation 없음, wallet 미관리) 외상 복구분만 wallet 동기화 (wallet-managed 는 wallet 경로가 처리).
      if (!isWalletManaged) {
        await this.legacyWalletCreditSyncService.syncCredit(queryRunner.manager, {
          billingUserId,
          orderId: order.id,
          orderDeliveryId: orderDelivery.id,
          delta: -restoreAmount,
          type: 'DISCARD_REFUND',
          memo: `폐기 여신 복구 (주문번호: ${order.id})`,
        });
      }
    }

    const refundRouteMemo = order.isSettleComplete
      ? '정산확정후폐기/선입금환불'
      : order.isSettleBalance
        ? '미정산/선입금환불'
        : '미정산/여신복구';
    // 여신(allSettleAmount) 복구인지 — 활동로그 재원 라벨 + 계정관리 이력관리 제외 판정에 공용.
    const isCreditRestore = restoreType === 'ALL_SETTLE_AMOUNT';

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
        restoreTarget: isCreditRestore ? 'CREDIT' : 'DEPOSIT',
        ...(isCreditRestore ? { beforeAllSettleAmount: beforeBalance, afterAllSettleAmount: afterBalance } : {}),
        beforeBalance,
        afterBalance,
        memo: `폐기복구(${refundRouteMemo})/ ${restoreAmount}원/ orderDelivery:${orderDelivery.id}`,
      },
    });

    // 계정관리 > 이력관리 항목 기록.
    // 여신복구(ALL_SETTLE_AMOUNT)는 예치금/선입금 이동 이력이 아니므로 계정관리 이력관리에서 제외한다.
    if (!isCreditRestore) {
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
        content: this.cryptoCipher.encryptDeliveryTarget(
          `${operatorName}/ ${restoreAmount.toLocaleString()}원 폐기/ 회수/ ${contactNumber} 폐기/ ${now}`,
        ),
      });
    }

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

  /**
   * 폐기후신규발송(핀교체, SSG·비-SSG 공통) — wallet-managed 주문에서 원본 delivery 의 wallet 장부를
   * 신규 delivery 로 승계한다. 고객 wallet 결제(allocation)는 SSG 여부와 무관하게 동일 승계 대상이며,
   * SSG 의 forfeit+신규 행사 재차감은 '행사 잔액'(공급사 측)에만 적용된다(고객 wallet 과 독립).
   *
   * 핀교체는 동일 결제를 그대로 승계(원본 폐기 시 환불 skip + 신규 재차감 없음)하므로,
   * 발송확정 때 원본 delivery 에 매겨진 allocation_line 과 attempt 를 신규 delivery 가 이어받아야 한다.
   * 승계하지 않으면 신규 delivery 를 폐기할 때:
   *   - attempt 부재 → restoreBalanceOnDiscard 의 drift 가드가 환불 abort (쿠폰 폐기O/환불X)
   *   - allocation_line 부재 → RefundPoolService 가 환불 대상 라인을 못 찾음
   * 가 발생한다.
   *
   * same-tx 보장을 위해 line repoint + attempt 생성을 한 트랜잭션으로 묶는다.
   */
  private async carryWalletOwnershipToReissuedDelivery(
    orderId: number,
    oldDeliveryId: number,
    newDeliveryId: number,
  ): Promise<void> {
    const isWalletManaged = await this.walletManagedPredicate.isWalletManaged(orderId);
    if (!isWalletManaged) {
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      const allocation = await manager.findOne(OrderPaymentAllocationEntity, {
        where: { orderId },
      });
      if (!allocation) {
        throw new Error(`reissue wallet carry: wallet-managed 인데 allocation 없음 (orderId=${orderId})`);
      }

      // 1) allocation_line repoint (원본 → 신규). 환불 풀이 line.order_delivery_id IN (targetIds) 로 라인을 찾으므로 필수.
      const lineUpdate = await manager.update(
        OrderPaymentAllocationLineEntity,
        { allocationId: allocation.id, orderDeliveryId: oldDeliveryId },
        { orderDeliveryId: newDeliveryId },
      );

      // 2) 신규 delivery 에 INITIAL(DEDUCTED) attempt 생성 — 폐기 환불 멱등키 cycle = attempt.id.
      await manager.save(OrderDeliveryAttemptEntity, {
        orderDeliveryId: newDeliveryId,
        attemptType: OrderDeliveryAttemptType.INITIAL,
        status: OrderDeliveryAttemptStatus.DEDUCTED,
        deductedAt: new Date(),
      });

      this.logger.log(
        `[폐기후신규발송] wallet 장부 승계 - orderId=${orderId} old=${oldDeliveryId} new=${newDeliveryId} ` +
          `lineRepointed=${lineUpdate.affected ?? 0}`,
      );
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
      barCode,
      keyword,
      eventName,
      expireDayMin,
      expireDayMax,
      page,
      take,
    } = getQuery;

    assertExpireDayRangeValid(expireDayMin, expireDayMax);

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
      .leftJoinAndMapOne(
        'order.clientUser',
        'user',
        'clientUser',
        'clientUser.id = order.client_user_id AND clientUser.deleted_at IS NULL',
      )
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
        '(user.companyId = :userCompanyId OR (clientUser.companyId = :userCompanyId AND order.apiAppId IS NULL))',
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
      queryBuilder.andWhere('(orderDelivery.barCode LIKE :barCode OR orderDelivery.personalCode LIKE :barCode)', {
        barCode: `%${barCode}%`,
      });
    }

    // 유효기간(일) 범위 — 초이스쿠폰은 선택된 상품 기준 (totalPrice 합계의 COALESCE 와 동일 기준)
    queryBuilder = QueryBuilderExpireDayCondition(
      queryBuilder,
      'COALESCE(choiceSelectProduct.expireDay, product.expireDay)',
      expireDayMin,
      expireDayMax,
    );

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
      const maskedDeliveryTarget = decryptedDeliveryTarget
        ? MaskingUtil.maskDeliveryTarget(decryptedDeliveryTarget)
        : null;

      // emailReceiverPhone 복호화 및 마스킹 처리
      const decryptedEmailReceiverPhone = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.emailReceiverPhone);
      const maskedEmailReceiverPhone = decryptedEmailReceiverPhone
        ? MaskingUtil.maskDeliveryTarget(decryptedEmailReceiverPhone)
        : null;

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
      const expireAt = orderDelivery.expireAt ? dayjs(orderDelivery.expireAt).format('YYYY-MM-DD') : null;

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
      const maskedEmailReceiverPhone = decryptedEmailReceiverPhone
        ? MaskingUtil.maskDeliveryTarget(decryptedEmailReceiverPhone)
        : null;

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

  async getDetail(
    user: ILoginUserInfo,
    getQuery: CustomerServiceGetDetailReqDto,
  ): Promise<CustomerServiceDlvryDetailViewDto> {
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
    let sendContent = applyReplaceCharacters(queryBuilder.orderProductMapping.sendContent ?? '', queryBuilder);

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
   * 동시 재발송 race 는 원자적 self-heal claim(claimedAt 토큰)으로 직렬화한다.
   * 기존 비관적 락(SELECT FOR UPDATE)+@Transactional 은 order_delivery 행을 잠근 채
   * oneSend()→issue() 의 외부 SSG API / REQUIRES_NEW 를 호출해 self-deadlock(lock wait)
   * 위험이 있었다. partner_company_extern_history.service.resendFailedDelivery 와 동일하게
   * 짧은 claim 으로 동시성만 차단하고, 락 없는 상태에서 oneSend() 를 호출한다.
   * - claim: app 생성 claimAt 토큰 저장. 5분 self-heal(크래시로 finally 못 탄 stale claim 만 재claim).
   * - reSend 상태집합은 COMPLETE/COMPLETE_SMS 를 포함하므로 boot sweep(FAIL 한정)이 커버하지 못한다
   *   → per-row self-heal(claimedAt<:stale)로 영구 stale 을 차단한다.
   * - 모든 해제(성공/실패/예외)는 owner guard(claimed_at=:claimAt) 조건부.
   */
  async reSend(user: ILoginUserInfo, getBody: CustomerServiceReSendReqDto) {
    const { orderDeliveryId } = getBody;
    const statuses = ['COMPLETE', 'FAIL', 'COMPLETE_SMS', 'FAIL_SMS'];

    // 1. 대상 조회 (락 없음). 동시 재발송은 아래 원자적 claim 으로 직렬화.
    const target = await this.buildReSendQuery(orderDeliveryId, statuses).getOne();
    if (!target) {
      throw new BadRequestException('주문 발송가 존재하지 않습니다.');
    }

    // 권한검사: 쿠폰 종류(일반/SSG)에 맞는 CS 권한 (getList 분류 기준과 동일, 그 외 타입은 거부)
    const requiredAuth = this.resolveCsCouponAuthority(target.orderProductMapping?.product?.type);
    if (!requiredAuth) {
      throw new BadRequestException('CS 대상이 아닌 상품 유형입니다.');
    }
    await this.authService.authorityValidator(user, requiredAuth);

    if (target.deliveryTarget === '-') {
      throw new BadRequestException('파기된 발송 정보입니다.');
    }

    // 폐기·환불된 쿠폰은 재발송하지 않는다 — 협력사에서 이미 죽은 핀이다.
    // status(COMPLETE/FAIL)와 coupon_status(NOT_USED/CANCEL)는 별개 축이라, 발송 뒤 폐기된 행은
    // status=COMPLETE + coupon_status=CANCEL 로 남아 위 status 필터를 그대로 통과한다.
    // 이 사전검사는 안내 문구용이고, 경합 차단은 아래 claim CAS 의 coupon_status 술어가 한다.
    if (target.couponStatus && UNSENDABLE_COUPON_STATUSES.includes(target.couponStatus)) {
      throw new BadRequestException('폐기·환불된 쿠폰은 재발송할 수 없습니다.');
    }

    // 2. 원자적 claim (owner 토큰 = app 생성 claimAt). 동시 재발송 직렬화 + 5분 self-heal.
    //    변형 lease(mutation_claimed_at)도 같은 CAS 로 함께 **획득**한다 (D3-55 후속).
    //    - WHERE 로 읽기만 하면 확인과 점유 사이에 폐기/외부취소가 진입해, 발송(수 초) 도중 협력사
    //      취소 + 환불을 마친다 → 이미 죽은 핀이 담긴 문자가 고객에게 배달된다.
    //      (외부 resendOrder 의 슬롯 CAS 를 "읽기→획득" 으로 고친 8a8f256 과 같은 이유)
    //    - 반대로 폐기가 먼저면 그쪽이 lease 를 쥐고 있어 이 CAS 가 affected=0 → 409 로 거절된다.
    const claimAt = new Date();
    const staleThreshold = new Date(claimAt.getTime() - RESEND_CLAIM_STALE_MS);
    const mutationStale = new Date(claimAt.getTime() - MUTATION_CLAIM_STALE_MS);
    const claimResult = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ claimedAt: claimAt, mutationClaimedAt: claimAt })
      .where('id = :id', { id: orderDeliveryId })
      .andWhere('status IN (:...statuses)', { statuses })
      .andWhere('(claimedAt IS NULL OR claimedAt < :stale)', { stale: staleThreshold })
      .andWhere('(mutation_claimed_at IS NULL OR mutation_claimed_at < :mutationStale)', { mutationStale })
      // 위 사전검사와 검사~claim 사이의 경합까지 닫는다(그 창에 폐기가 들어오면 여기서 affected=0).
      .andWhere('(coupon_status IS NULL OR coupon_status NOT IN (:...unsendable))', {
        unsendable: UNSENDABLE_COUPON_STATUSES,
      })
      .execute();
    if (!claimResult.affected) {
      throw new ConflictException('재발송 처리 중이거나 상태가 변경되었습니다. 잠시 후 다시 시도해주세요.');
    }

    // 3. 발송 (락 없는 상태). oneSend 가 PIN 발급/확인 + 이미지 + 실제 발송 처리.
    //    성공/실패/예외 모든 종료 경로에서 owner-guarded(claimed_at=:claimAt) claim 해제(finally).
    try {
      const orderDelivery = await this.buildReSendQuery(orderDeliveryId, statuses).getOne();
      if (!orderDelivery) {
        throw new Error('claim 후 재조회 실패');
      }
      await this.deliveryBatchService.oneSend(orderDelivery);
    } finally {
      // claimedAt 해제가 던져도 변형 lease 는 반드시 푼다. 안 풀면 최대 5분간 이 건의
      // 폐기·외부취소·재발행이 전부 거절된다(둘은 별개 컬럼이라 한쪽 실패가 다른 쪽을 막으면 안 된다).
      try {
        await this.orderDeliveryRepository.update({ id: orderDeliveryId, claimedAt: claimAt }, { claimedAt: null });
      } catch (releaseError) {
        this.logger.error(
          `[CS_RESEND] claimedAt 해제 실패 — orderDeliveryId=${orderDeliveryId}, error: ${releaseError}`,
        );
      }
      await this.releaseMutationLease(orderDeliveryId, claimAt);
    }
  }

  /**
   * 쿠폰상태 변형(폐기/외부취소/재발행) lease 획득 — 원자적 CAS.
   * 비었거나 stale(5분 초과)일 때만 획득. affected=0 이면 다른 변형 작업이 진행 중.
   * claimedAt(발송배치 lease)과 별개 컬럼 — 배치는 stale 정책이 없고 부팅 sweep 이
   * WAIT+claimedAt 을 무조건 해제하므로 겸용 시 살아있는 점유가 강탈·삭제된다.
   */
  private async acquireMutationLease(orderDeliveryId: number, claimAt: Date): Promise<boolean> {
    const staleThreshold = new Date(claimAt.getTime() - MUTATION_CLAIM_STALE_MS);
    const result = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ mutationClaimedAt: claimAt })
      .where('id = :id', { id: orderDeliveryId })
      .andWhere('(mutationClaimedAt IS NULL OR mutationClaimedAt < :stale)', { stale: staleThreshold })
      .execute();
    return !!result.affected;
  }

  /**
   * 아직 내가 변형 lease 를 쥐고 있는가. 되돌릴 수 없는 외부 부작용(문자 발송) 직전의 마지막 관문.
   *
   * fenced update 는 "쓰기"를 막을 뿐 "발송"을 막지 못한다. 비SSG 는 유효기간 fenced update 가
   * 사실상 이 검사를 겸하지만 SSG 는 그 분기를 타지 않아(issue() 가 expireAt 을 채움) 검사 지점이
   * 없었다. lease 를 잃었다 = 다른 폐기/취소가 이 핀을 협력사에서 죽이고 환불까지 했을 수 있다.
   */
  private async isMutationLeaseOwned(orderDeliveryId: number, claimAt: Date): Promise<boolean> {
    const row = await this.orderDeliveryRepository.findOne({
      where: { id: orderDeliveryId, mutationClaimedAt: claimAt },
      select: ['id'],
    });
    return !!row;
  }

  /**
   * 변형 lease 해제 (owner guard). 내가 소유한 lease(mutationClaimedAt=:claimAt)만 해제 —
   * stale 강탈로 소유권이 넘어갔으면 affected=0 으로 아무것도 지우지 않는다(reSend claim 해제와 동일 규약).
   * 해제 실패는 로깅만 — stale(5분) self-heal 이 최후 안전망.
   */
  private async releaseMutationLease(orderDeliveryId: number, claimAt: Date): Promise<void> {
    try {
      await this.orderDeliveryRepository.update(
        { id: orderDeliveryId, mutationClaimedAt: claimAt },
        { mutationClaimedAt: null },
      );
    } catch (releaseErr) {
      this.logger.error(`[변형lease] 해제 실패 — orderDeliveryId=${orderDeliveryId}`, releaseErr);
    }
  }

  /** CS 재전송 대상 조회(relation 포함, 재발송 가능 상태 필터). 락 없음. */
  private buildReSendQuery(orderDeliveryId: number, statuses: string[]) {
    return (
      this.orderDeliveryRepository
        .createQueryBuilder('orderDelivery')
        .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
        .innerJoinAndSelect('orderProductMapping.order', 'order')
        .innerJoinAndSelect('order.user', 'user')
        .leftJoinAndSelect('user.company', 'company')
        .innerJoinAndSelect('orderProductMapping.product', 'product')
        .innerJoinAndSelect('product.brand', 'brand')
        .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
        .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
        .leftJoinAndSelect('choiceSelectProduct.brand', 'choiceSelectBrand')
        .where('orderDelivery.id = :orderDeliveryId', { orderDeliveryId })
        .andWhere('orderDelivery.status IN (:...statuses)', { statuses })
        // 비동기 수신확인 진행중(PENDING)인 건은 재진입 차단 (msgKey 덮어쓰기/이중처리 방지).
        // 단 recovery 후 FAIL(reportState=UNCONFIRMED)·CONFIRMED 는 수동 재발송 허용해야 하므로 PENDING 만 제외.
        .andWhere('(orderDelivery.reportState IS NULL OR orderDelivery.reportState != :pendingReportState)', {
          pendingReportState: IOrderDeliveryReportState.PENDING,
        })
    );
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
    let destroyAmount = calculateSettlementPrice(
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

    // 변형 lease 획득 — "서로 다른 행위의 교차"(재발행 중 폐기, 취소 중 폐기 등)를 입구에서 차단.
    // (terminal 가드=로드 스냅샷 검사, Tx1 CAS=동일행위(폐기×2) 멱등 게이트 — 각각 역할이 다르다.)
    // 재발행 tip 은 INSERT 시점부터 lease 를 보유하므로, 발급/발송 중인 tip 폐기는 여기서 거절된다.
    const mutationClaimAt = new Date();
    if (!(await this.acquireMutationLease(orderDelivery.id, mutationClaimAt))) {
      throw new BadRequestException('해당 발송 건에 다른 처리가 진행 중입니다. 잠시 후 다시 시도해 주세요.');
    }
    try {
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
            // 협력사 어댑터 cancel()은 실패를 '반환값'이 아니라 throw 로 알린다(galaxia/giftiel/giftishow/culture/daou 공통).
            // 따라서 실패는 try/catch 로 받아야 한다. (D3-46: 기존 `result.message !== '폐기 완료'` 분기는
            // 래퍼가 성공 시 항상 '폐기 완료'만 반환하므로 도달 불가한 데드코드였음)
            // catch 에서는 추가 logger 를 두지 않는다 — 어댑터가 이미 infra 레벨에서 1회 로깅하므로 중복 방지.
            try {
              await this.partnerCompanyExternService.cancel(orderDelivery);
            } catch (e) {
              const syncedStatus = await this.syncCouponStatusAfterDiscardFailure(orderDelivery);
              const statusSuffix = syncedStatus ? ` (현재 쿠폰상태: ${syncedStatus})` : '';
              const reason = e instanceof Error ? e.message : '폐기 처리 실패';
              throw new InternalServerErrorException(`${reason}${statusSuffix}`);
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
          if (restoreAmount !== null && orderDelivery.orderProductMapping.order.isSettleComplete) {
            destroyAmount = restoreAmount;
          }
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
        await this.orderHistoryRepository.update(savedHistoryId, { destroyAmount, restoreAmount });
      }

      return { orderDelivery, beforeChange, refundStatus, refundError, destroyAmount, restoreAmount };
    } finally {
      await this.releaseMutationLease(orderDelivery.id, mutationClaimAt);
    }
  }

  /**
   * 폐기 역전 (폐기 후 신규 발송 롤백용). CAS: 아직 CANCEL 일 때만 originalStatus 로 되돌리고 discardedAt 해제.
   * SSG 폐기는 외부 cancel 을 호출하지 않으므로(SsgDB 미터치) 상태 플립만으로 안전하게 원복된다.
   */
  private async reverseDiscard(orderDeliveryId: number, originalStatus: OrderDeliveryCouponStatus): Promise<boolean> {
    const result = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ couponStatus: originalStatus, discardedAt: null })
      .where('id = :id AND coupon_status = :cancel', {
        id: orderDeliveryId,
        cancel: OrderDeliveryCouponStatus.CANCEL,
      })
      .execute();
    // affected=0 = CAS 불일치(이미 다른 액터가 상태를 바꿈) → 복구 실패.
    // caller 가 "폐기를 취소했습니다" 라고 말하기 전에 반드시 확인해야 한다 (리뷰 HIGH).
    return (result.affected ?? 0) > 0;
  }

  /**
   * 핀폐기 API (직접 호출용) — 폐기 실행 + history 기록
   * 환불 실패 시 폐기 사실은 이미 저장된 상태로 명시적 에러 메시지를 반환한다.
   */
  async pinDiscard(user: ILoginUserInfo, getBody: CustomerServiceDiscardReqDto) {
    const result = await this.execDiscard(user, getBody.orderDeliveryId, getBody.couponStatus, {
      type: CS_HISTORY_TYPE.DISCARD,
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

    // 변형 lease 게이트 (D3-55 후속). execDiscard 와 동일 — terminal 가드 직후, 협력사 cancel 앞.
    // 핀상태변경도 coupon_status 를 CANCEL 로 쓰고 협력사 취소를 태우므로, 재발행/외부취소/배치발송이
    // 진행 중인 행에 진입하면 "발송 중인 핀을 죽이고 문자는 그대로 나가는" 상태가 된다.
    const mutationClaimAt = new Date();
    if (!(await this.acquireMutationLease(orderDelivery.id, mutationClaimAt))) {
      throw new BadRequestException('해당 발송 건에 다른 처리가 진행 중입니다. 잠시 후 다시 시도해 주세요.');
    }

    try {
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
            // 협력사 cancel()은 실패 시 throw 로 알리므로(반환값 아님), 여기까지 도달하면 성공이다.
            // (D3-46: 기존 `if (result.message === '폐기 완료') ... else throw` 의 else 는 도달 불가 데드코드였음)
            await this.partnerCompanyExternService.cancel(orderDelivery);

            await this.commitPinStatusTransition(
              orderDelivery.id,
              beforeChange,
              { couponStatus: OrderDeliveryCouponStatus.CANCEL, discardedAt: new Date() },
              { userId: map.userId, type, content, afterChange: OrderDeliveryCouponStatus.CANCEL },
            );
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
    } finally {
      await this.releaseMutationLease(orderDelivery.id, mutationClaimAt);
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
    } else if (getBody.type === CS_HISTORY_TYPE.RESEND && !getBody.extraType) {
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
      case CS_HISTORY_TYPE.RESEND: {
        break;
      }
      case CS_HISTORY_TYPE.RECEIVER_CHANGE: {
        beforeChange = orderDelivery.deliveryTarget;
        break;
      }
      case CS_HISTORY_TYPE.DISCARD:
      case CS_HISTORY_TYPE.REFUND_DISCARD: {
        beforeChange = orderDelivery.couponStatus;
        break;
      }
      case CS_HISTORY_TYPE.DISCARD_REISSUE: {
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
    if (getBody.type === CS_HISTORY_TYPE.RESEND) {
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
    } else if (getBody.type === CS_HISTORY_TYPE.RECEIVER_CHANGE || getBody.type === CS_HISTORY_TYPE.DISCARD_REISSUE) {
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
   * 재전송 실행 (중복 발송 방어).
   * 비관락(pessimistic_write)으로 동시·연속 재전송 요청을 직렬화하고,
   * 락 보유 중 최근 시간창 내 동일 건 '재전송' 이력이 있으면 중복으로 보고 거부한다.
   * 더블클릭/더블서밋으로 같은 발송 건이 2회 나가던 문제를 막는다.
   * 발송 성공 후 같은 트랜잭션에서 이력을 저장하므로, 이 이력 자체가 후속 요청의 dedup 마커가 된다.
   * 발송 실패 시 트랜잭션 롤백 → 이력 미생성 → 거짓 차단 없음.
   */
  @Transactional()
  private async execResend(map: any): Promise<void> {
    // 같은 건을 이 시간(ms) 내 다시 재전송하면 중복으로 간주하고 차단한다.
    const RESEND_DEDUP_WINDOW_MS = 10_000;

    // 1. 비관락 — 동시·연속 재전송 요청 직렬화 (reSend 와 동일 패턴)
    const locked = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .setLock('pessimistic_write')
      .where('orderDelivery.id = :id', { id: map.orderDeliveryId })
      .getOne();
    if (!locked) {
      throw new BadRequestException('존재하지 않는 발송 정보입니다.');
    }

    // 비동기 수신확인 진행중(PENDING)이면 재진입 차단 (reportSweep 소관 — 중복 발송 방지). reSend 와 동일.
    if (locked.reportState === IOrderDeliveryReportState.PENDING) {
      throw new BadRequestException('수신 확인 진행중인 발송입니다. 잠시 후 다시 시도해주세요.');
    }

    // ★ 이것도 **발송 경로**다 (리뷰 CRITICAL, D3-55 후속).
    //   csResendAs* 는 쿠폰 이미지와 핀번호가 담긴 문자를 고객에게 그대로 보낸다. 그런데 종전에는
    //   폐기·환불 여부도, 변형 lease 도 보지 않았다.
    //
    //   ① 폐기 쿠폰 — 레이스도 아니고 **결정적**이다.
    //      status(COMPLETE)와 coupon_status(CANCEL)는 별개 축이라, 발송 완료 후 폐기·환불된 건은
    //      status=COMPLETE + coupon_status=CANCEL 로 남는다. 운영자가 CS 화면에서 "재전송" 을
    //      누르면 협력사에서 이미 죽고 환불까지 끝난 핀이 고객에게 다시 배달된다.
    //
    //   ② 진행중인 변형 — 비관락으로는 못 막는다.
    //      execDiscard 는 lease 를 잡은 뒤 **행 락을 놓고** 협력사 cancel(외부 통신, 수 초)에 들어간다.
    //      그 창에서 이 비관락은 아무것도 막지 못한다(폐기가 그 행의 락을 쥐고 있지 않으므로 즉시 획득된다).
    //      lease 를 읽어야만 "취소 진행 중" 을 알 수 있다.
    //
    //   여기서는 lease 를 **획득하지 않고 읽기만 한다.** 이 트랜잭션이 pessimistic_write 로 행을
    //   잡고 있는 동안에는 남이 lease 를 획득하는 UPDATE 자체가 블록되므로, 검사~발송 사이에
    //   새 변형이 끼어들 수 없다(검사와 발송이 락 구간 안에서 원자적이다).
    if (locked.couponStatus && UNSENDABLE_COUPON_STATUSES.includes(locked.couponStatus)) {
      throw new BadRequestException('폐기·환불된 쿠폰은 재전송할 수 없습니다.');
    }
    const mutationStale = new Date(Date.now() - MUTATION_CLAIM_STALE_MS);
    if (locked.mutationClaimedAt && locked.mutationClaimedAt >= mutationStale) {
      throw new ConflictException(
        '해당 발송 건에 다른 처리(폐기/취소/재발행)가 진행 중입니다. 잠시 후 다시 시도해주세요.',
      );
    }

    // 2. dedup — 락 보유 중 최근 시간창 내 동일 건 재전송 이력 확인
    const dedupSince = new Date(Date.now() - RESEND_DEDUP_WINDOW_MS);
    const recentResendCount = await this.orderHistoryRepository.count({
      where: {
        orderDeliveryId: map.orderDeliveryId,
        type: CS_HISTORY_TYPE.RESEND,
        createdAt: MoreThanOrEqual(dedupSince),
      },
    });
    if (recentResendCount > 0) {
      throw new ConflictException('이미 재전송 요청이 처리되었습니다. 잠시 후 다시 시도해주세요.');
    }

    // 3. 실제 발송
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

    // 4. 이력 저장 — 락 보유 중 커밋되어 후속 중복 요청의 dedup 마커가 된다
    await this.orderHistoryRepository.save(
      this.orderHistoryRepository.create({
        orderDeliveryId: map.orderDeliveryId,
        userId: map.userId,
        type: map.type,
        content: map.content,
        sendMethod: map.sendMethod,
        beforeChange: map.beforeChange,
        afterChange: '',
      }),
    );
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
      case CS_HISTORY_TYPE.SIMPLE_INQUIRY: {
        break;
      }
      case CS_HISTORY_TYPE.RESEND: {
        // 더블클릭/더블서밋으로 같은 건이 2회 발송되던 문제 방어.
        // execResend 가 비관락·dedup·발송·이력저장을 한 트랜잭션에서 처리하므로 공통 이력 저장은 건너뛴다.
        await this.execResend(map);
        return;
      }
      case CS_HISTORY_TYPE.RECEIVER_CHANGE: {
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
      case CS_HISTORY_TYPE.DISCARD_REISSUE: {
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
            await this.deliveryBatchService.reverseReissueDeductDirect(
              resendDeductionId,
              reissueEvent.id,
              reissueOrderId,
              reissuePrice,
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
         * SSG 선차감+폐기 완전 역전 헬퍼. issue() 호출 전(미등록 확정) 구간에서 공유.
         *
         * ★ 순서: tip 무력화 먼저 → 폐기 역전 나중 (리뷰 CRITICAL 로 종전과 반대).
         *   종전(폐기 역전 → softDelete)은 중간 중단·softDelete 실패 시 "원본 복구 + 살아있는 tip"
         *   이 된다. 그 tip 은 status=WAIT / barCode=NULL / claimed_at=NULL 이고 finally 가 lease 를
         *   해제하므로 claimWaitDeliveries 를 전부 통과한다 → 배치가 **새 PIN 을 발급해 발송**한다.
         *   SSG 선차감은 이미 역복원된 뒤라 **미차감 발급**(직접 자금 손실) + 고객 쿠폰 2장이 된다.
         *   반대 순서면 중단 시 남는 상태가 "둘 다 폐기"(무해·복구가능)다.
         *
         * ★ softDelete 만으로는 부족하다: 실패를 삼키면 배치가 그대로 집어간다. 그래서 먼저
         *   status/couponStatus 를 CANCEL 로 전이(fenced)해 claimWaitDeliveries 를 확실히 막는다.
         *
         * @param od - issue() 전 단계라면 fullDelivery 아직 없을 수 있으므로 orderDelivery 사용
         * @param savedId - 이미 save 한 newDelivery 의 id (없으면 null)
         * @param reverseOriginal - 원본 폐기를 되돌릴지. **SSG 에서만 true** 여야 한다.
         *        reverseDiscard 는 coupon_status 를 되돌리는 상태 플립일 뿐이다. SSG 폐기는 외부
         *        cancel 을 호출하지 않으므로(SsgDB 미터치) 플립만으로 안전하게 원복된다. 그러나
         *        **비-SSG 폐기는 협력사 cancel 을 이미 태웠다** — 협력사에서 죽은 핀을 우리 DB 에서만
         *        살려내면 "DB 는 살아있는데 협력사에선 죽은 쿠폰"이 된다(고객이 못 쓰는 쿠폰 +
         *        환불도 이미 나감). 비-SSG 는 tip 무력화만 하고 원본은 폐기 상태로 둔다.
         * @returns discardReversed - 원본 폐기 역전 성공 여부. false 면 caller 는 "폐기를 취소했습니다"
         *          라고 말하면 안 된다(고객 쿠폰이 폐기된 채 남아 있다).
         *          reverseOriginal=false 로 호출했으면 애초에 되돌릴 의도가 없으므로 false 다.
         */
        const unwindReissue = async (
          od: OrderDeliveryEntity,
          savedId: number | null,
          outcome: SsgRefundOutcome,
          reverseOriginal = true,
        ): Promise<{ discardReversed: boolean; tipNeutralized: boolean }> => {
          // 1) tip 무력화 — 먼저. 배치 픽업 차단이 최우선이다.
          //
          // ★ tipNeutralized 는 폐기 역전의 **전제조건**이다 (리뷰 HIGH).
          //   무력화에 실패했다는 것은 = 변형 lease 를 잃었다 = 그 tip 은 살아서 배치가 집어
          //   PIN 을 발급·발송할 수 있다는 뜻이다. 그 상태에서 원본 폐기까지 되돌리면
          //   **살아있는 쿠폰이 2장**(원본 + 배치가 보낸 tip)이 된다.
          //   반대로 되돌리지 않으면 남는 상태는 "원본 폐기 + tip 발송" = 재발행이 배치 경유로
          //   완료된 것과 같아 고객 피해가 없다. 후자를 택한다.
          let tipNeutralized = true;
          if (savedId != null) {
            tipNeutralized = false;
            try {
              const kill = await this.orderDeliveryRepository.update(
                { id: savedId, mutationClaimedAt: mutationClaimAt },
                { status: IOrderDeliveryStatus.CANCEL, couponStatus: OrderDeliveryCouponStatus.CANCEL },
              );
              // affected=0 ⟺ WHERE 의 lease 토큰 불일치 ⟺ 남이 이 행을 가져갔다.
              tipNeutralized = (kill.affected ?? 0) > 0;
              if (!tipNeutralized) {
                this.logger.error(
                  `[폐기후신규발송] tip 무력화 실패 — 변형 lease 상실(다른 처리가 선점). ` +
                    `배치가 집어 PIN 을 발급·발송할 수 있다. 운영 확인 필요. orderDeliveryId=${savedId}`,
                );
              }
            } catch (killErr) {
              this.logger.error(
                `[폐기후신규발송] tip 무력화 실패(outcome=${outcome}) — orderDeliveryId=${savedId}`,
                killErr,
              );
            }
            // ★ softDelete 는 무력화에 **성공했을 때만** 한다 (리뷰 HIGH).
            //
            //   tipNeutralized=false 는 "남이 이 tip 을 가져갔다" 는 뜻이고, 그 '남' 의 대표는
            //   **stale lease 를 탈취해 지금 이 tip 을 발송 중인 발송배치**다. 그 행을 우리가 지우면:
            //     - 배치의 targeted update 는 soft-delete 필터를 안 타므로 발송은 **그대로 진행**된다
            //     - 남는 상태: deleted_at 찍힌 행 + 고객 손의 살아있는 쿠폰 + 협력사 과금 완료
            //     - CS 목록에서 안 보이고, 정산 대상에서 빠지고(과금당했는데 청구 못 함),
            //       폐기·환불도 불가능하다. 게다가 softDelete 는 **성공**하므로 아무 신호도 없다.
            //   내 것이 아닌 행을 지울 권리는 없다.
            if (tipNeutralized) {
              try {
                await this.orderDeliveryRepository.softDelete(savedId);
              } catch (sdErr) {
                // 무력화가 이미 배치를 차단했으므로 여기 실패는 로깅으로 충분(행이 남을 뿐).
                this.logger.error(
                  `[폐기후신규발송] softDelete 실패(outcome=${outcome}) — orderDeliveryId=${savedId}`,
                  sdErr,
                );
              }
            } else {
              this.logger.error(
                `[폐기후신규발송] lease 상실로 softDelete 도 보류 — 남의 행(발송 진행중일 수 있다)은 지우지 않는다. ` +
                  `orderDeliveryId=${savedId}`,
              );
            }
          }

          // 2) 폐기 역전(고객 원본 쿠폰 복구) — 나중. 성공 여부를 caller 에게 알린다.
          let discardReversed = true;

          // 비-SSG 는 폐기 시 협력사 cancel 을 이미 태웠으므로 상태 플립으로 되살릴 수 없다.
          // tip 무력화(위)만 하고 원본은 폐기 상태로 둔다.
          //
          // ⚠️ 남는 상태를 정확히 적는다 (4차 리뷰 HIGH — 종전 주석이 "환불 완료" 라고 **거짓**을 썼다):
          //   재발행의 폐기는 execDiscard(..., { skipBalanceRestore: true }) 로 호출된다("핀 교체"
          //   전제라 잔액 복구를 건너뛴다). 즉 **환불은 집행되지 않았다.**
          //   따라서 남는 상태는:
          //     원본 = 협력사 취소됨 + coupon_status=CANCEL + **환불 없음**
          //     tip  = 무력화(또는 무력화 실패 시 살아있음)
          //     고객 = **쿠폰 없음 + 환불 없음.** 결제만 그대로다 → 수동 환불/재발급이 필요하다.
          //   재시도도 불가하다(원본이 CANCEL 이라 execDiscard 터미널 가드에 걸린다).
          //   그래서 caller 는 반드시 "운영팀 문의" 를 띄워야 한다 — 아래 ERROR 로그가 그 근거다.
          if (!reverseOriginal) {
            this.logger[tipNeutralized ? 'error' : 'error'](
              `[폐기후신규발송] 비-SSG 재발행 실패 — 원본은 협력사에서 취소됐고 **환불은 집행되지 않았다**` +
                `(skipBalanceRestore). 수동 환불/재발급 필요. ` +
                `tip 무력화=${tipNeutralized ? '성공' : '실패(배치가 자동 발송할 수 있다)'}. ` +
                `원본=${discardedDelivery.id}, tip=${savedId}`,
            );
            return { discardReversed: false, tipNeutralized };
          }

          if (!tipNeutralized) {
            // 되돌리지 않는다(쿠폰 2장 방지). caller 는 "폐기를 취소했습니다" 라고 말하면 안 된다.
            this.logger.error(
              `[폐기후신규발송] tip 을 무력화하지 못해 원본 폐기 역전을 건너뛴다 — ` +
                `배치가 tip(${savedId}) 을 발송할 수 있고, 원본(${discardedDelivery.id})은 폐기 상태로 남는다. ` +
                `SSG 선차감은 이미 역복원되어 미차감 발급이 될 수 있다. 운영 확인 필요.`,
            );
            return { discardReversed: false, tipNeutralized };
          }
          if (discardBeforeValidated) {
            try {
              discardReversed = await this.reverseDiscard(discardedDelivery.id, discardBeforeValidated);
            } catch (rdErr) {
              discardReversed = false;
              this.logger.error(
                `[폐기후신규발송] reverseDiscard 실패(outcome=${outcome}) — orderDeliveryId=${discardedDelivery.id}`,
                rdErr,
              );
            }
            if (!discardReversed) {
              this.logger.error(
                `[폐기후신규발송] 원본 폐기 역전 실패(CAS 불일치 또는 예외) — 고객 쿠폰이 폐기 상태로 남아 있다. ` +
                  `운영 확인 필요. orderDeliveryId=${discardedDelivery.id}`,
              );
            }
          }
          return { discardReversed, tipNeutralized };
        };

        /**
         * 비-SSG 재발행 실패 시 운영자에게 보낼 메시지.
         *
         * 실제 잔여 상태를 그대로 말한다 (4차 리뷰 HIGH — 종전에는 "핀 발급에 실패했습니다" 처럼
         * **원본이 죽었다는 사실도, 환불이 안 나갔다는 사실도** 한 글자도 없었다):
         *   - 원본: 협력사에서 취소됨. **환불 없음**(재발행 폐기는 skipBalanceRestore:true — 핀 교체 전제)
         *   - 재시도 불가: 원본이 CANCEL 이라 execDiscard 터미널 가드에 걸린다(운영자는 이유를 모른다)
         *   - tip 무력화 실패 시: 배치가 그 tip 을 **자동 발송**할 수 있고, wallet 미승계라 이후 환불 불가
         */
        const buildNonSsgReissueFailureMessage = (tipNeutralized: boolean): string =>
          `재발행에 실패했습니다. 원본 쿠폰(발송건 ${discardedDelivery.id})은 협력사에서 이미 취소되어 ` +
          `되돌릴 수 없고, 환불도 집행되지 않았습니다. 재시도하지 마시고 운영팀에 문의해 ` +
          `수동 환불 또는 재발급을 진행해 주세요.` +
          (tipNeutralized
            ? ''
            : ` ⚠️ 신규 발송 건(${savedDelivery?.id ?? '-'})을 무력화하지 못해 자동 발송될 수 있습니다.`);

        // 변형 lease: tip 은 새 행이므로 INSERT 자체가 원자적 획득(CAS 불필요).
        // issue()/발송(외부 통신, 수 초) 동안 폐기(execDiscard)·외부취소(cancelOrder)·발송배치가
        // 이 행에 진입하지 못하게 한다. 해제는 아래 try/finally(owner guard).
        // 크래시로 해제를 못 타면 stale(5분) 후 다음 획득자가 CAS 로 강탈한다(self-heal).
        const mutationClaimAt = new Date();

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
        newDelivery.mutationClaimedAt = mutationClaimAt;
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
          // ★ lease 해제는 unwind 가 끝난 뒤에. 먼저 반납하면 그 창에 tip 이
          //   status=WAIT / claimed_at=NULL / lease 없음 / soft-delete 전 상태로 노출되어
          //   claimWaitDeliveries 를 전부 통과한다 → 배치가 PIN 을 발급·발송하고,
          //   뒤이어 unwind 가 원본 폐기를 되돌리면 살아있는 쿠폰이 2장이 된다 (리뷰 CONFIRMED).
          //
          // ★★ unwind 는 isSsg 게이트 **밖**이어야 한다 (리뷰 HIGH, 양쪽 일치).
          //    종전에는 unwind 전체가 `if (isSsg && ...)` 안에 있어서, **비-SSG** 재발행이
          //    여기로 오면(save 성공 + findOne 실패) tip 무력화도 softDelete 도 폐기 역전도
          //    **아무것도 하지 않고** finally 가 lease 만 반납했다. 남는 tip:
          //      status=WAIT / claimed_at=NULL / coupon_status=NOT_USED / lease 없음 / deleted_at=NULL
          //    → claimWaitDeliveries 를 전부 통과 → 배치가 PIN 을 발급해 고객에게 발송한다.
          //    그런데 carryWalletOwnershipToReissuedDelivery 는 실행되지 않았다(아래 단계다).
          //    즉 이 파일이 다른 곳에서 "절대 만들면 안 된다" 고 못 박은 상태 —
          //    **발송된 tip + wallet 미승계** — 가 그대로 만들어진다. 이후 그 쿠폰을 폐기하면
          //    attempt/line 부재로 환불이 drift abort 된다(고객도 우리도 돈이 없다).
          //    게다가 order_history 는 이 시점에 아직 한 줄도 없어 CS 는 추적조차 못 한다.
          //    tip 무력화는 SSG 여부와 무관하다. SSG 선차감 역복원만 SSG 게이트 안에 둔다.
          try {
            if (isSsg && reissueEvent && resendDeductionId) {
              await this.deliveryBatchService.reverseReissueDeductDirect(
                resendDeductionId,
                reissueEvent.id,
                reissueOrderId,
                reissuePrice,
              );
            }
            // reverseOriginal 은 SSG 에서만. 비-SSG 원본은 협력사 cancel 이 이미 나갔다.
            const unwound = await unwindReissue(
              orderDelivery,
              savedDelivery?.id ?? null,
              SsgRefundOutcome.RESTORED,
              isSsg,
            );
            // 비-SSG 는 원본이 죽고 환불도 안 나갔다 — 원문 에러("새 발송 건 조회에 실패했습니다")로는
            // 운영자가 그 사실을 알 수 없다. 실제 잔여 상태를 말해 주는 메시지로 갈아끼운다.
            if (!isSsg) {
              this.logger.error(
                `[폐기후신규발송] 비-SSG pre-issue 실패 — orderDeliveryId=${savedDelivery?.id}`,
                preIssueErr,
              );
              throw new InternalServerErrorException(buildNonSsgReissueFailureMessage(unwound.tipNeutralized));
            }
          } finally {
            if (savedDelivery?.id != null) {
              await this.releaseMutationLease(savedDelivery.id, mutationClaimAt);
            }
          }
          throw preIssueErr;
        }

        try {
          const ssgEvent = fullDelivery.ssgEvent ?? null;

          // PIN 발급 — 실패 시 SSG 선차감 역복원 + (미등록 확정이면) 폐기 역전·새 delivery 제거
          try {
            // 선차감 pending 에 issue 시도 기록(실제 신규 delivery id) — sweep W1 구분 phase.
            // issue try 보상 범위 안에 둬서 이 마킹이 throw 해도 catch(issueError)가 역복원+unwind 하도록 한다(MEDIUM).
            // (이 시점 fullDelivery 는 미발급 → state=NONE → resolver RESTORED → 안전.)
            if (isSsg && reissueEvent && resendDeductionId) {
              await this.deliveryBatchService.markReissueIssueAttempted(resendDeductionId, fullDelivery.id);
            }
            await this.partnerCompanyExternService.issue(fullDelivery, ssgEvent);
          } catch (issueError) {
            if (isSsg && reissueEvent && resendDeductionId) {
              const outcome = await this.deliveryBatchService.reverseSsgReissueDeduct(
                fullDelivery,
                reissueEvent.id,
                reissuePrice,
                reissueOrderId,
                resendDeductionId,
              );
              if (outcome === SsgRefundOutcome.RESTORED) {
                const { discardReversed } = await unwindReissue(fullDelivery, savedDelivery.id, outcome);
                // 복구가 실제로 됐을 때만 "다시 시도" 를 유도한다. 실패했는데 그렇게 말하면
                // 운영자는 복구된 줄 알고 재시도하지만 원본이 폐기 상태라 터미널 가드에 걸린다.
                // 고객은 쿠폰을 잃었는데 CS 는 이유를 모르는 상태가 된다 (리뷰 HIGH).
                if (!discardReversed) {
                  throw new InternalServerErrorException(
                    `신규 발송에 실패했고 원본 쿠폰 복구도 실패했습니다. 재시도하지 마시고 운영팀에 문의해 주세요. ` +
                      `(발송건 ${discardedDelivery.id})`,
                  );
                }
                throw new InternalServerErrorException('신규 발송에 실패하여 폐기를 취소했습니다. 다시 시도해 주세요.');
              }
              this.logger.error(
                `[폐기후신규발송] issue 실패하나 SSG 등록 불명/확정(outcome=${outcome}) — 폐기 유지. orderDeliveryId=${savedDelivery.id}`,
              );
              throw new InternalServerErrorException(
                '신규 발송 처리 중 오류가 발생했습니다. 발송실패내역에서 상태를 확인해 주세요.',
              );
            }
            // ★ 비-SSG 도 tip 을 무력화해야 한다 (리뷰 HIGH).
            //   issue() 의 catch 가 세팅하는 status=FAIL 은 **메모리 전용**이다(issue 는 더 이상
            //   order_delivery 를 save 하지 않는다) → DB 행은 WAIT 그대로다. 여기서 그냥 throw 하면
            //   finally 가 lease 를 반납하고, tip 은 claimWaitDeliveries 를 전부 통과해
            //   배치가 새 PIN 을 발급·발송한다. 운영자에겐 실패라고 답했는데 고객은 쿠폰을 받고,
            //   carryWallet 은 아직 실행 전이라 **wallet 미승계 tip 이 배달**된다(폐기해도 환불 불가).
            //   비-SSG 원본은 협력사 cancel 을 이미 태워 되살릴 수 없으므로 reverseOriginal=false.
            const unwound = await unwindReissue(fullDelivery, savedDelivery.id, SsgRefundOutcome.RESTORED, false);
            this.logger.error(`[폐기후신규발송] 비-SSG issue 실패 — orderDeliveryId=${savedDelivery.id}`, issueError);
            throw new InternalServerErrorException(buildNonSsgReissueFailureMessage(unwound.tipNeutralized));
          }

          // HIGH-2: issue() 성공 후 barCode 없음 — SSG 는 outcome 으로 분기, 비SSG 는 단순 throw
          if (!fullDelivery.barCode) {
            if (isSsg && reissueEvent && resendDeductionId) {
              const outcome = await this.deliveryBatchService.reverseSsgReissueDeduct(
                fullDelivery,
                reissueEvent.id,
                reissuePrice,
                reissueOrderId,
                resendDeductionId,
              );
              if (outcome === SsgRefundOutcome.RESTORED) {
                const { discardReversed } = await unwindReissue(fullDelivery, savedDelivery.id, outcome);
                // 복구가 실제로 됐을 때만 "다시 시도" 를 유도한다. 실패했는데 그렇게 말하면
                // 운영자는 복구된 줄 알고 재시도하지만 원본이 폐기 상태라 터미널 가드에 걸린다.
                // 고객은 쿠폰을 잃었는데 CS 는 이유를 모르는 상태가 된다 (리뷰 HIGH).
                if (!discardReversed) {
                  throw new InternalServerErrorException(
                    `신규 발송에 실패했고 원본 쿠폰 복구도 실패했습니다. 재시도하지 마시고 운영팀에 문의해 주세요. ` +
                      `(발송건 ${discardedDelivery.id})`,
                  );
                }
                throw new InternalServerErrorException('신규 발송에 실패하여 폐기를 취소했습니다. 다시 시도해 주세요.');
              }
              this.logger.error(
                `[폐기후신규발송] barCode 누락 + SSG 등록 불명/확정(outcome=${outcome}) — 폐기 유지. orderDeliveryId=${savedDelivery.id}`,
              );
              throw new InternalServerErrorException(
                '신규 발송 처리 중 오류가 발생했습니다. 발송실패내역에서 상태를 확인해 주세요.',
              );
            }
            // ★ 비-SSG 도 tip 을 무력화한다 (위 issue 실패 경로와 동일 근거).
            //   barCode 가 없다 = 발급 실패 = 이 tip 은 죽어야 한다. 살려 두면 배치가 집어
            //   **새 PIN 을 발급해** 고객에게 보낸다(운영자에겐 "핀 발급에 실패했습니다" 라고 답한 뒤).
            const unwound = await unwindReissue(fullDelivery, savedDelivery.id, SsgRefundOutcome.RESTORED, false);
            throw new InternalServerErrorException(buildNonSsgReissueFailureMessage(unwound.tipNeutralized));
          }

          const newPin = fullDelivery.barCode;
          afterChange = `${normalizedTarget} / ${newPin}`;

          // ★ 이력은 **발송 전**, PIN 이 확정된 즉시 남긴다 (리뷰 MEDIUM).
          //
          //   종전에는 발송 뒤에 기록했는데, 그 사이의 lease 상실 throw 들이 전부 이 지점보다
          //   앞이라 이력이 통째로 사라졌다. 그런데 그 throw 들은 "발송이 안 됐다" 는 뜻이 아니다
          //   — tip 은 status=WAIT + barCode 로 남아 배치가 이어서 발송할 수 있다. 즉 **고객은
          //   PIN 을 받았는데 CS 에는 그 PIN 의 이력이 없는** 상태가 된다.
          //   협력사에서 이미 발급·과금된 PIN 이므로, 발송 성공 여부와 무관하게 "이 PIN 이
          //   이 주문에 발급됐다" 는 사실 자체를 남겨야 한다. 발송 결과는 order_delivery.status 가
          //   따로 들고 있다.
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

          // issue 성공 + barCode 확인 + durable save 완료 후에야 선차감 pending KEPT 해소(차감 유지 확정).
          // barCode 검증 이전에 KEPT 하면 이후 !barCode 분기의 DEFERRED 역복원을 sweep 이 재시도 못 함(HIGH).
          if (isSsg && reissueEvent && resendDeductionId) {
            await this.deliveryBatchService.resolveReissuePendingKept(resendDeductionId);
          }

          // Wallet Cutover — wallet-managed 면 원본 delivery 의 allocation_line/attempt 를 신규 delivery 로 승계한다.
          // 미승계 시 이후 신규 delivery 폐기에서 attempt/line 부재로 환불이 drift abort 된다.
          // SSG·비-SSG 공통(고객 wallet 결제는 SSG 여부와 무관 — 상세는 carryWalletOwnershipToReissuedDelivery JSDoc).
          //
          // ★ 아래 유효기간 fencing 보다 **앞**이어야 한다 (리뷰 HIGH).
          //   fencing 이 lease 상실로 throw 하면 tip 은 status=WAIT + barCode(발급·과금 완료) 로
          //   남아 배치가 그대로 고객에게 발송한다. 그때 wallet 이 미승계면 이후 그 쿠폰을 폐기해도
          //   attempt/line 부재로 환불이 drift abort 된다 — 돈이 고객에게도, 우리에게도 없는 상태.
          //   반대로 barCode 검사(=unwind 경로)보다는 **뒤**여야 한다. unwind 는 tip 을 softDelete
          //   하는데, 그 tip 으로 wallet 을 옮겨 두면 원본의 환불 근거가 사라진다.
          //
          // ★ 이 함수 자신이 throw 하는 경우도 막아야 한다 (리뷰 HIGH).
          //   그냥 전파시키면 finally 가 lease 를 반납하고, tip 은 status=WAIT + barCode(발급·과금
          //   완료) + claimed_at=NULL + coupon_status=NOT_USED + lease 없음 으로 남아
          //   claimWaitDeliveries 를 **전부 통과**한다 → 배치가 5분 안에 고객에게 발송한다.
          //   그런데 wallet 은 미승계라(그래서 여기 온 것) 이후 그 쿠폰을 폐기해도 환불이 drift
          //   abort 된다 — 고객은 쿠폰을 잃고 환불도 못 받는다.
          //   아직 lease 를 쥐고 있으니 tip 을 fenced 로 무력화해 배치 픽업을 끊는다.
          try {
            await this.carryWalletOwnershipToReissuedDelivery(reissueOrderId, discardedDelivery.id, savedDelivery.id);
          } catch (carryErr) {
            const kill = await this.orderDeliveryRepository.update(
              { id: savedDelivery.id, mutationClaimedAt: mutationClaimAt },
              { status: IOrderDeliveryStatus.CANCEL, couponStatus: OrderDeliveryCouponStatus.CANCEL },
            );
            const tipKilled = (kill.affected ?? 0) > 0;
            this.logger.error(
              `[폐기후신규발송] wallet 승계 실패 — tip 무력화 ${tipKilled ? '성공' : '실패(배치가 발송할 수 있다)'}. ` +
                `발급된 PIN 은 협력사에서 살아있다(과금됨). 원본은 폐기 상태로 남는다. 운영 확인 필요. ` +
                `orderDeliveryId=${savedDelivery.id}`,
              carryErr,
            );
            // ★ 메시지도 kill 결과로 갈라야 한다 (리뷰 HIGH).
            //   무력화 실패(lease 상실)면 배치가 그 tip 을 발송한다 — "발송을 중단했습니다" 는
            //   정확히 반대다. 운영자가 "안 나갔구나" 하고 고객에게 미발송 안내를 하는 사이
            //   쿠폰이 배달되고, 그 쿠폰은 wallet 미승계라 나중에 폐기해도 환불이 안 된다.
            throw new InternalServerErrorException(
              tipKilled
                ? `신규 PIN 은 발급됐으나 결제 정보 승계에 실패해 발송을 중단했습니다. ` +
                    `재시도하지 마시고 운영팀에 문의해 주세요. (발송건 ${savedDelivery.id})`
                : `신규 PIN 이 발급됐고 결제 정보 승계에 실패했습니다. 발송 중단에도 실패해 ` +
                    `**해당 건이 자동 발송될 수 있습니다.** 발송되면 이후 환불이 불가하니 ` +
                    `재시도하지 마시고 즉시 운영팀에 문의해 주세요. (발송건 ${savedDelivery.id})`,
            );
          }

          // 폐기 후 신규발송: 새 쿠폰이므로 유효기간 새로 계산 (SSG는 issue() 내부에서 expireAt 채움 → 제외)
          //
          // save(fullDelivery) 금지: fullDelivery 는 issue() 전에 로드한 스냅샷이라
          // couponStatus/discardedAt 이 로드 시점 값으로 굳어 있다. issue() 는 외부 통신이라 수 초가 걸리고,
          // 그 사이 폐기(execDiscard)·외부 취소(cancelOrder)가 같은 행에 CANCEL 을 쓸 수 있다.
          // save 는 행 전체를 쓰므로 그 CANCEL 을 stale 값으로 되돌려 "환불됐는데 살아있는 핀" 을 만든다.
          // 발급 결과(barCode/personalCode/couponNum/ssgTransactionId)는 issue() 가 이미 targeted update 로
          // 반영했으므로(partner.company.extern.service.ts) 여기서는 재계산한 유효기간만 쓴다.
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

            // fencing: 내 lease 일 때만 기록. stale 강탈(좀비화) 시 affected=0 — 남의 결정을 덮지 않는다.
            const expiryWrite = await this.orderDeliveryRepository.update(
              { id: fullDelivery.id, mutationClaimedAt: mutationClaimAt },
              { expireAt: fullDelivery.expireAt, encourageAt: fullDelivery.encourageAt },
            );
            if (!expiryWrite.affected) {
              // affected=0 = lease 를 빼앗겼다 = 다른 액터가 지금 이 tip 을 만지고 있다.
              // 여기서 우리가 발송하지는 않는다(죽은 핀 배달 방지). 다만 **발송이 취소된 것은 아니다** —
              // tip 은 status=WAIT + barCode 로 남아, 탈취자가 폐기/취소면 coupon_status=CANCEL 가드에
              // 걸려 배치가 거르고, 탈취자가 배치면 배치가 이어서 발송한다. 그래서 메시지는
              // "실패" 가 아니라 "자동 발송 가능 + 운영 확인" 이어야 한다.
              // (부수: expireAt/encourageAt 이 NULL 로 남아 만료 배치·취소 만료가드가 오작동)
              this.logger.error(
                `[폐기후신규발송] 변형 lease 상실(다른 처리가 선점) — 발송 중단. orderDeliveryId=${fullDelivery.id}`,
              );
              // 409(Conflict) — 진짜 서버 버그(500)와 구분한다. 외부 API 의 3010 과 대칭.
              // 500 으로 두면 어드민 프론트가 "잠시 후 다시 시도" 로 뭉갤 수 있는데, 이 메시지는
              // 정확히 그 반대(재시도 금지)를 말한다. 알림/대시보드에서도 5xx 노이즈에 묻힌다.
              throw new ConflictException(
                `처리 중 다른 작업이 이 발송 건을 선점했습니다. 해당 건이 자동 발송될 수 있으니 ` +
                  `재시도하지 마시고 운영팀에 확인해 주세요. (발송건 ${fullDelivery.id})`,
              );
            }
          }

          // 발송 직전 lease 소유 재확인 — 비SSG 는 위 유효기간 fenced update 가 이 역할을 하지만
          // SSG 는 그 분기를 타지 않아(issue() 가 expireAt 을 채움) 검사 지점이 없었다.
          // lease 를 잃었다 = 다른 폐기/취소가 이 핀을 죽이고 있다 → 발송하면 죽은 핀이 배달된다.
          if (!(await this.isMutationLeaseOwned(fullDelivery.id, mutationClaimAt))) {
            this.logger.error(
              `[폐기후신규발송] 발송 직전 변형 lease 상실(다른 처리가 선점) — 발송 중단. orderDeliveryId=${fullDelivery.id}`,
            );
            // 위 유효기간 fencing 과 동일 — tip 은 WAIT 로 남아 발송실패내역에 뜨지 않는다. 409.
            throw new ConflictException(
              `처리 중 다른 작업이 이 발송 건을 선점했습니다. 해당 건이 자동 발송될 수 있으니 ` +
                `재시도하지 마시고 운영팀에 확인해 주세요. (발송건 ${fullDelivery.id})`,
            );
          }

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
          // save(fullDelivery) 금지 — 위 유효기간 update 와 같은 이유.
          // 발송 시도(csResendAsXxx)도 외부 통신이라 수 초가 걸리고, 그 사이 폐기·취소가 들어올 수 있다.
          // 발송 결과 3컬럼만 targeted update + fencing(내 lease 일 때만) — couponStatus/discardedAt 을 덮지 않는다.
          const sendWrite = await this.orderDeliveryRepository.update(
            { id: fullDelivery.id, mutationClaimedAt: mutationClaimAt },
            {
              status: fullDelivery.status,
              actualSendAt: fullDelivery.actualSendAt,
              failedAt: fullDelivery.failedAt,
            },
          );
          // 발송 후 lease 상실 — 아래 history 를 남긴 뒤 throw 한다. 성공으로 반환하면 안 된다.
          let leaseLostAfterSend = false;
          if (!sendWrite.affected) {
            leaseLostAfterSend = true;
            // 문자는 이미 나갔는데 lease 를 빼앗겨 status 를 못 썼다. 이대로 두면 tip 은 INSERT 당시
            // status=WAIT 로 남고, claimWaitDeliveries 의 lease 배제도 더 이상 걸리지 않아
            // **배치가 같은 핀으로 재발송**한다(고객 문자 2통). 되돌릴 수 없는 발송이 이미
            // 일어난 이상, 최소한 상태는 WAIT 에서 떼어내야 한다.
            //
            // fallback 은 lease 가 아니라 status=WAIT 로 소유권을 좁힌다. tip 의 WAIT→발송결과 전이는
            // 재발행 액터만 책임지는 구간이고, 배치가 이미 집어갔다면 status 가 바뀌어 affected=0 이
            // 되어 남의 결정을 덮지 않는다.
            this.logger.error(
              `[폐기후신규발송] 발송결과 fenced 기록 실패 — 변형 lease 상실(다른 처리가 선점). ` +
                `문자는 이미 발송됨. status fallback 시도. orderDeliveryId=${fullDelivery.id}`,
            );
            const fallbackWrite = await this.orderDeliveryRepository.update(
              { id: fullDelivery.id, status: IOrderDeliveryStatus.WAIT },
              {
                status: fullDelivery.status,
                actualSendAt: fullDelivery.actualSendAt,
                failedAt: fullDelivery.failedAt,
              },
            );
            if (!fallbackWrite.affected) {
              this.logger.error(
                `[폐기후신규발송] status fallback 도 실패(이미 다른 액터가 전이) — 발송은 나갔으나 ` +
                  `DB 상태를 확정하지 못했다. 운영 확인 필요. orderDeliveryId=${fullDelivery.id}`,
              );
            }
          }

          // history 는 PIN 확정 직후(발송 전)에 이미 남겼다 — 위 주석 참조.

          if (sendError) {
            throw new InternalServerErrorException(
              `신규 PIN ${newPin}이(가) 발급되었으나 발송에 실패했습니다. 발송실패내역에서 재발송해 주세요.`,
            );
          }

          // ★ 발송 후 lease 상실은 성공이 아니다 (리뷰 CRITICAL).
          //   lease 를 빼앗겼다 = 다른 폐기/취소가 이 핀을 죽이고 있(었)다는 뜻이다. 문자는 이미
          //   나갔으니 되돌릴 수 없지만, 그 핀은 협력사에서 취소·환불됐을 수 있다. 여기서 성공을
          //   반환하면 CS 화면에는 "재발행 완료" 로 뜨고, 고객은 죽은 핀을 들고 전화한다.
          //   외부 API resendOrder 는 같은 상황에서 3010 을 던진다 — 내부만 성공을 주장할 이유가 없다.
          //   history 는 위에서 이미 남겼으므로(발급된 PIN 추적 가능) 여기서 던져도 이력은 보존된다.
          if (leaseLostAfterSend) {
            // 409 — 외부 API resendOrder 의 3010 과 대칭.
            throw new ConflictException(
              `신규 PIN ${newPin}이(가) 발송되었으나, 그 사이 다른 처리가 이 발송 건을 선점했습니다. ` +
                `쿠폰이 취소·환불되었을 수 있으니 운영팀에 확인해 주세요. (발송건 ${savedDelivery.id})`,
            );
          }

          return;
        } finally {
          // 정상/실패(throw) 모든 종료 경로에서 owner-guarded 해제.
          // unwindReissue 가 soft-delete 한 뒤에도 무해(affected=0 또는 lease 만 정리).
          await this.releaseMutationLease(savedDelivery.id, mutationClaimAt);
        }
      }
      case CS_HISTORY_TYPE.DISCARD: {
        const result = await this.execDiscard(map.user, map.orderDeliveryId, OrderDeliveryCouponStatus.CANCEL);
        afterChange = result.orderDelivery.couponStatus;
        discardDestroyAmount = result.destroyAmount;
        discardRestoreAmount = result.restoreAmount;
        if (result.refundStatus === 'FAILED' && result.refundError) {
          pendingRefundError = result.refundError;
        }
        break;
      }
      case CS_HISTORY_TYPE.REFUND_DISCARD: {
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

        if (h.type === CS_HISTORY_TYPE.RECEIVER_CHANGE) {
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

  private async calculateSettledDiscardRestoreAmount(
    orderDelivery: OrderDeliveryEntity,
    queryRunner: QueryRunner,
  ): Promise<number> {
    const mapping = orderDelivery.orderProductMapping;
    const order = mapping.order;
    const snapshotAmount = order.settledAmountSnapshot ?? order.settleAmount ?? 0;
    if (snapshotAmount <= 0) {
      return 0;
    }

    const deliveries = await this.getSettlementCompleteDeliveriesForDiscardAllocation(orderDelivery, queryRunner);
    const deliveryBaseAmounts = deliveries.map((delivery) => ({
      delivery,
      baseAmount: calculateSettlementPrice(delivery.orderProductMapping, false, delivery),
    }));
    const totalBaseAmount = deliveryBaseAmounts.reduce((sum, entry) => sum + entry.baseAmount, 0);
    if (totalBaseAmount <= 0) {
      return 0;
    }

    const currentBaseAmount =
      deliveryBaseAmounts.find((entry) => Number(entry.delivery.id) === Number(orderDelivery.id))?.baseAmount ??
      calculateSettlementPrice(mapping, false, orderDelivery);
    const alreadyRestoredAmount = await this.getSettledDiscardRestoreAmount(order.id, queryRunner);
    const remainingAmount = Math.max(0, snapshotAmount - alreadyRestoredAmount);
    if (deliveryBaseAmounts.length === 1) {
      return remainingAmount;
    }

    const allocatedAmount = Math.floor((remainingAmount * currentBaseAmount) / totalBaseAmount);
    return Math.min(allocatedAmount, remainingAmount);
  }

  private async getSettlementCompleteDeliveriesForDiscardAllocation(
    orderDelivery: OrderDeliveryEntity,
    queryRunner: QueryRunner,
  ): Promise<OrderDeliveryEntity[]> {
    const orderDeliveries = orderDelivery.orderProductMapping.orderDeliveries;
    if (orderDeliveries?.length) {
      return orderDeliveries.filter((delivery) =>
        this.isDeliveryIncludedInSettlementSnapshot(delivery, orderDelivery.id),
      );
    }

    if (typeof queryRunner.manager.getRepository !== 'function') {
      return [orderDelivery];
    }

    const orderId = orderDelivery.orderProductMapping.order.id;
    return queryRunner.manager
      .getRepository(OrderDeliveryEntity)
      .createQueryBuilder('delivery')
      .innerJoinAndSelect('delivery.orderProductMapping', 'mapping')
      .leftJoinAndSelect('mapping.product', 'product')
      .innerJoinAndSelect('mapping.order', 'order')
      .where('order.id = :orderId', { orderId })
      .andWhere('delivery.deletedAt IS NULL')
      .andWhere('delivery.status IN (:...completeStatuses)', {
        completeStatuses: [IOrderDeliveryStatus.COMPLETE, IOrderDeliveryStatus.COMPLETE_SMS],
      })
      .andWhere(
        '(delivery.couponStatus IS NULL OR delivery.couponStatus != :cancelStatus OR delivery.id = :deliveryId)',
        {
          cancelStatus: OrderDeliveryCouponStatus.CANCEL,
          deliveryId: orderDelivery.id,
        },
      )
      .getMany();
  }

  private isDeliveryIncludedInSettlementSnapshot(delivery: OrderDeliveryEntity, currentDeliveryId: number): boolean {
    const isComplete =
      delivery.status === IOrderDeliveryStatus.COMPLETE || delivery.status === IOrderDeliveryStatus.COMPLETE_SMS;
    if (!isComplete) {
      return false;
    }
    return (
      delivery.couponStatus !== OrderDeliveryCouponStatus.CANCEL || Number(delivery.id) === Number(currentDeliveryId)
    );
  }

  private async getSettledDiscardRestoreAmount(orderId: number, queryRunner: QueryRunner): Promise<number> {
    if (typeof queryRunner.manager.getRepository !== 'function') {
      return 0;
    }

    const row = await queryRunner.manager
      .getRepository(OrderDeliveryRefundEntity)
      .createQueryBuilder('refund')
      .innerJoin(OrderDeliveryEntity, 'delivery', 'delivery.id = refund.order_delivery_id')
      .innerJoin('delivery.orderProductMapping', 'mapping')
      .select('SUM(refund.refundAmount)', 'totalRestore')
      .where('mapping.orderId = :orderId', { orderId })
      .andWhere('refund.sourcePath = :sourcePath', { sourcePath: 'CS_DISCARD' })
      .andWhere('refund.isSettleComplete = :isSettleComplete', { isSettleComplete: true })
      .andWhere('refund.restoreType IN (:...restoreTypes)', { restoreTypes: ['BALANCE', 'COMPANY_BALANCE'] })
      .getRawOne<{ totalRestore?: string | number | null }>();

    return Number(row?.totalRestore) || 0;
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

          // 3-2. 변형 lease 획득 (D3-55 후속). 재발행/외부취소/배치발송이 이 행을 진행 중이면 skip.
          // 없으면 재발행이 issue()/발송(외부 통신 수 초) 중인 tip 을 다중폐기가 협력사 취소 + 환불까지
          // 마치고, 재발행은 그대로 진행해 **이미 죽은 핀이 담긴 문자를 고객에게 배달**한다.
          // fencing 은 내 쓰기만 보호할 뿐, 남이 CANCEL 을 쓰는 것을 막지 못하므로 게이트가 필요하다.
          const mutationClaimAt = new Date();
          if (!(await this.acquireMutationLease(orderDelivery.id, mutationClaimAt))) {
            failed.push({
              id: orderDeliveryId,
              reason: '해당 발송 건에 다른 처리가 진행 중입니다. 잠시 후 다시 시도해 주세요.',
            });
            continue;
          }

          try {
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
                // 협력사 cancel()은 실패를 throw 로 알린다(반환값 아님) → try/catch 로 받아야 함.
                // (D3-46: 기존 `result.message !== '폐기 완료'` 분기는 도달 불가한 데드코드였음)
                // catch 에서 추가 logger 없음 — 어댑터가 이미 infra 레벨 1회 로깅(중복 방지).
                try {
                  await this.partnerCompanyExternService.cancel(orderDelivery);
                } catch (e) {
                  const syncedStatus = await this.syncCouponStatusAfterDiscardFailure(orderDelivery);
                  failed.push({
                    id: orderDeliveryId,
                    reason: (e instanceof Error ? e.message : '') || '외부 API 폐기 실패',
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
              let destroyAmount = calculateSettlementPrice(
                orderDelivery.orderProductMapping,
                orderDelivery.orderProductMapping.order.cardSurchargeApplied,
                orderDelivery,
              );
              if (restoreAmount !== null && orderDelivery.orderProductMapping.order.isSettleComplete) {
                destroyAmount = restoreAmount;
              }

              // CS 히스토리 저장
              const history = this.orderHistoryRepository.create({
                orderDeliveryId: orderDelivery.id,
                userId: user.id,
                type: CS_HISTORY_TYPE.DISCARD,
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
          } finally {
            await this.releaseMutationLease(orderDelivery.id, mutationClaimAt);
          }
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
      expireDayMin,
      expireDayMax,
    } = searchParams;

    assertExpireDayRangeValid(expireDayMin, expireDayMax);

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
      .leftJoinAndMapOne(
        'order.clientUser',
        'user',
        'clientUser',
        'clientUser.id = order.client_user_id AND clientUser.deleted_at IS NULL',
      )
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
        '(user.companyId = :userCompanyId OR (clientUser.companyId = :userCompanyId AND order.apiAppId IS NULL))',
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
      queryBuilder.andWhere('(orderDelivery.barCode LIKE :barCode OR orderDelivery.personalCode LIKE :barCode)', {
        barCode: `%${barCode}%`,
      });
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

    // 유효기간(일) 범위 — 초이스쿠폰은 선택된 상품 기준 (getList 와 동일 조건)
    queryBuilder = QueryBuilderExpireDayCondition(
      queryBuilder,
      'COALESCE(choiceSelectProduct.expireDay, product.expireDay)',
      expireDayMin,
      expireDayMax,
    );

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

    fileStream.on('error', (err) => {
      this.logger.error(`파일 스트림 오류: ${err}`);
      fs.unlink(filePath, () => {});
      if (!res.headersSent) {
        res.status(500).json({ message: '파일 다운로드 중 오류가 발생했습니다.' });
      } else {
        res.destroy();
      }
    });

    fileStream.on('close', () => {
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) {
          this.logger.error(`엑셀 임시파일 삭제 실패: ${unlinkErr}`);
        }
      });
    });
  }
}
