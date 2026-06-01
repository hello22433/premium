// typeorm-transactional 데코레이터를 no-op으로 mock (실제 DB 트랜잭션 없음)
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, _descriptor: unknown) => _descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeliverySendHistoryEntity } from '../../entity/delivery.send.history.entity';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderEntity } from '../../entity/order.entity';
import { OrderRealProductEntity } from '../../entity/order.real.product.entity';
import { OrderRealProductMappingEntity } from '../../entity/order.real.product.mapping.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { UserEntity } from '../../entity/user.entity';
import { OrderDeliveryAttemptEntity } from '../../entity/order.delivery.attempt.entity';
import { OrderPaymentRefundEventType } from '../../entity/order.payment.refund.event.entity';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { IOrderType } from '../../order/interface/order.type';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';
import { UserManagementService } from '../../user_management/application/user.management.service';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { DeliveryTrackHttp } from '../infra/delivery.track.http';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';
import { WalletManagedPredicate } from '../../wallet/application/wallet-managed.predicate';
import { RefundPoolService } from '../../wallet/application/refund-pool.service';
import { DeliveryBatchService } from './delivery.batch.service';
import { ResendDeductService } from '../../wallet/application/resend-deduct.service';
import { OrderPaymentRefundEventEntity } from '../../entity/order.payment.refund.event.entity';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DeliverySendService } from './delivery.send.service';
import { RefundLedgerService } from './refund-ledger.service';
import { SsgInsertStateService } from './ssg-insert-state.service';
import { SsgRefundResolverService } from './ssg-refund.resolver';

/**
 * PR2-006 — refundForFail wallet path 분기 회귀.
 *
 * Hook: refundLedgerService.claim() 성공 후 walletManagedPredicate.isWalletManaged(order.id) 분기.
 *   - true  → RefundPoolService.refund({ FAIL_REFUND, [deliveryId], 'fail_refund:O:D:A' })
 *             user.balance / allSettleAmount 환원 경로 SKIP.
 *   - false → 기존 user.balance / allSettleAmount 경로 그대로.
 * SSG 행사 잔액 복구는 wallet 분기에 영향받지 않음 (별도 회귀 spec 보유).
 */
describe('DeliveryBatchService.refundForFail - wallet path', () => {
  let sut: DeliveryBatchService;
  let refundLedgerService: jest.Mocked<RefundLedgerService>;
  let userManagementService: jest.Mocked<UserManagementService>;
  let walletManagedPredicate: { isWalletManaged: jest.Mock };
  let refundPoolService: { refund: jest.Mock };
  let orderDeliveryAttemptRepository: { findOne: jest.Mock };
  let userRepoExecute: jest.Mock;

  // 비-SSG 일반 주문 (SSG 잔액 복구 분기 회피). isSettleBalance=true → balance 환원 경로.
  const buildOrderDelivery = (): OrderDeliveryEntity => ({
    id: 770001,
    status: IOrderDeliveryStatus.FAIL,
    deliveryMethod: IOrderSendMethod.MMS,
    ssgEventId: null,
    barCode: null,
    refundedAt: null,
    orderProductMapping: {
      id: 1,
      cardSurchargeAmount: 0,
      order: {
        id: 8800,
        type: IOrderType.GENERAL,
        isSettleComplete: false,
        isSettleBalance: true,
        cardSurchargeApplied: false,
        clientUserId: null,
        user: { id: 5500 },
      },
      product: {
        id: 1,
        price: 10_000,
        expireDay: 60,
        type: 'NORMAL',
        partnerCompany: { type: 'NORMAL' },
      },
    },
  } as unknown as OrderDeliveryEntity);

  beforeEach(async () => {
    jest.clearAllMocks();

    refundLedgerService = {
      exists: jest.fn(),
      claim: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      isSsgSettled: jest.fn().mockResolvedValue(true),
      markSsgSettled: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RefundLedgerService>;

    userManagementService = {
      deductBalance: jest.fn(),
      addBalance: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<UserManagementService>;

    userRepoExecute = jest.fn().mockResolvedValue({});
    const userRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        setParameters: jest.fn().mockReturnThis(),
        execute: userRepoExecute,
      }),
    } as unknown as Repository<UserEntity>;

    walletManagedPredicate = {
      isWalletManaged: jest.fn().mockResolvedValue(false),
    };
    refundPoolService = {
      refund: jest.fn().mockResolvedValue({ ledgerIds: ['L1'], totalRefundedAmount: 10_000 }),
    };
    orderDeliveryAttemptRepository = {
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryBatchService,
        { provide: getRepositoryToken(OrderEntity), useValue: {} },
        { provide: getRepositoryToken(OrderRealProductEntity), useValue: {} },
        { provide: getRepositoryToken(OrderRealProductMappingEntity), useValue: {} },
        { provide: getRepositoryToken(OrderDeliveryEntity), useValue: { update: jest.fn() } },
        { provide: getRepositoryToken(DeliverySendHistoryEntity), useValue: {} },
        { provide: getRepositoryToken(EmailSendHistoryEntity), useValue: {} },
        { provide: getRepositoryToken(UserEntity), useValue: userRepo },
        { provide: getRepositoryToken(SsgEventEntity), useValue: { findOne: jest.fn() } },
        { provide: 'DeliveryAlimTalk', useValue: {} },
        { provide: 'IMailSend', useValue: {} },
        { provide: 'ISmsSend', useValue: {} },
        { provide: DeliveryTrackHttp, useValue: {} },
        { provide: CryptoCipher, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: 'IFileStorage', useValue: {} },
        { provide: PartnerCompanyExternService, useValue: {} },
        { provide: SsgEventService, useValue: { refundForDeliveryFail: jest.fn() } },
        { provide: UserManagementService, useValue: userManagementService },
        { provide: DeliverySendService, useValue: {} },
        { provide: RefundLedgerService, useValue: refundLedgerService },
        { provide: SsgInsertStateService, useValue: { getState: jest.fn() } },
        { provide: SsgRefundResolverService, useValue: { resolveAndRefundIfNeeded: jest.fn() } },
        { provide: WalletManagedPredicate, useValue: walletManagedPredicate },
        { provide: RefundPoolService, useValue: refundPoolService },
        { provide: getRepositoryToken(OrderDeliveryAttemptEntity), useValue: orderDeliveryAttemptRepository },
        { provide: ResendDeductService, useValue: { resendDeduct: jest.fn(), resendUndo: jest.fn() } },
        { provide: getRepositoryToken(OrderPaymentRefundEventEntity), useValue: { find: jest.fn(), findOne: jest.fn() } },
        { provide: getRepositoryToken(OrderPaymentAllocationEntity), useValue: { findOne: jest.fn() } },
        { provide: getDataSourceToken(), useValue: { transaction: jest.fn() } },
      ],
    }).compile();

    sut = module.get(DeliveryBatchService);
  });

  it('legacy 경로: isWalletManaged=false → userManagementService.addBalance 호출, refundPoolService.refund 미호출', async () => {
    const od = buildOrderDelivery();
    walletManagedPredicate.isWalletManaged.mockResolvedValue(false);

    await (sut as any).refundForFail(od);

    expect(refundLedgerService.claim).toHaveBeenCalledTimes(1);
    expect(walletManagedPredicate.isWalletManaged).toHaveBeenCalledWith(od.orderProductMapping.order.id);
    expect(userManagementService.addBalance).toHaveBeenCalledTimes(1);
    expect(refundPoolService.refund).not.toHaveBeenCalled();
    expect(orderDeliveryAttemptRepository.findOne).not.toHaveBeenCalled();
  });

  it('wallet 경로: isWalletManaged=true → RefundPoolService.refund 호출 (fail_refund 멱등키 = active attempt.id), addBalance 미호출', async () => {
    const od = buildOrderDelivery();
    walletManagedPredicate.isWalletManaged.mockResolvedValue(true);
    // 재발송 후 재실패: 최신 attempt 는 RESEND(id=99). INITIAL 고정이면 이전 prefix 충돌로 no-op.
    orderDeliveryAttemptRepository.findOne.mockResolvedValue({ id: '99' });

    await (sut as any).refundForFail(od);

    // attemptType=INITIAL 필터가 아니라 최신(id DESC) attempt 를 조회해야 한다 (HIGH 2).
    expect(orderDeliveryAttemptRepository.findOne).toHaveBeenCalledWith({
      where: { orderDeliveryId: od.id },
      order: { id: 'DESC' },
    });
    expect(refundLedgerService.claim).toHaveBeenCalledTimes(1);
    expect(refundPoolService.refund).toHaveBeenCalledTimes(1);
    expect(refundPoolService.refund).toHaveBeenCalledWith({
      orderId: od.orderProductMapping.order.id,
      eventType: OrderPaymentRefundEventType.FAIL_REFUND,
      targetDeliveryIds: [od.id],
      idempotencyKeyPrefix: `fail_refund:${od.orderProductMapping.order.id}:${od.id}:99`,
    });
    expect(userManagementService.addBalance).not.toHaveBeenCalled();
    expect(userRepoExecute).not.toHaveBeenCalled();
  });

  it('wallet 경로 + attempt 부재: drift → throw 전파 (refund 미호출, 상위 retry 신호)', async () => {
    const od = buildOrderDelivery();
    walletManagedPredicate.isWalletManaged.mockResolvedValue(true);
    orderDeliveryAttemptRepository.findOne.mockResolvedValue(null);

    await expect((sut as any).refundForFail(od)).rejects.toThrow(
      /missing attempt/,
    );

    expect(refundPoolService.refund).not.toHaveBeenCalled();
    expect(userManagementService.addBalance).not.toHaveBeenCalled();
  });
});
