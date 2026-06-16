// typeorm-transactional 데코레이터를 no-op으로 mock (실제 DB 트랜잭션 없음)
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, _descriptor: unknown) => _descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { DeliverySendHistoryEntity } from '../../entity/delivery.send.history.entity';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderEntity } from '../../entity/order.entity';
import { OrderRealProductEntity } from '../../entity/order.real.product.entity';
import { OrderRealProductMappingEntity } from '../../entity/order.real.product.mapping.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { UserEntity } from '../../entity/user.entity';
import { OrderDeliveryAttemptEntity } from '../../entity/order.delivery.attempt.entity';
import { OrderPaymentRefundEventEntity } from '../../entity/order.payment.refund.event.entity';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderHistoryEntity } from '../../entity/order.history.entity';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';
import { UserManagementService } from '../../user_management/application/user.management.service';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { DeliveryTrackHttp } from '../infra/delivery.track.http';
import { DeliveryBatchService } from './delivery.batch.service';
import { DeliverySendService } from './delivery.send.service';
import { RefundLedgerService } from './refund-ledger.service';
import { SsgInsertStateService } from './ssg-insert-state.service';
import { SsgRefundResolverService } from './ssg-refund.resolver';
import { OrderFromService } from '../../order_from/application/order.from.service';
import { WalletManagedPredicate } from '../../wallet/application/wallet-managed.predicate';
import { RefundPoolService } from '../../wallet/application/refund-pool.service';
import { ResendDeductService } from '../../wallet/application/resend-deduct.service';
import { SsgRefundOutcome } from '../interface/ssg.refund.resolve';

describe('DeliveryBatchService', () => {
  let service: DeliveryBatchService;
  let ssgEventService: jest.Mocked<SsgEventService>;
  let ssgRefundResolverService: jest.Mocked<SsgRefundResolverService>;

  beforeEach(async () => {
    jest.clearAllMocks();

    const ssgEventServiceMock = {
      selectEventForOrder: jest.fn(),
      deductEventBalance: jest.fn(),
      chargeBackForResend: jest.fn(),
      deductForReissueWithPending: jest.fn().mockResolvedValue({ resendDeductionId: 'ULID-TEST' }),
      markReissueIssueAttempted: jest.fn().mockResolvedValue(undefined),
      resolveReissuePending: jest.fn().mockResolvedValue(undefined),
      refundResendEventDeduction: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryBatchService,
        { provide: getRepositoryToken(OrderEntity), useValue: {} },
        { provide: getRepositoryToken(OrderRealProductEntity), useValue: {} },
        { provide: getRepositoryToken(OrderRealProductMappingEntity), useValue: {} },
        { provide: getRepositoryToken(OrderDeliveryEntity), useValue: { update: jest.fn(), save: jest.fn(), manager: {} } },
        { provide: getRepositoryToken(DeliverySendHistoryEntity), useValue: { save: jest.fn() } },
        { provide: getRepositoryToken(EmailSendHistoryEntity), useValue: {} },
        { provide: getRepositoryToken(UserEntity), useValue: {} },
        { provide: getRepositoryToken(SsgEventEntity), useValue: { findOne: jest.fn() } },
        { provide: 'DeliveryAlimTalk', useValue: {} },
        { provide: 'IMailSend', useValue: {} },
        { provide: 'ISmsSend', useValue: { send: jest.fn() } },
        { provide: DeliveryTrackHttp, useValue: {} },
        { provide: CryptoCipher, useValue: { decryptDeliveryTarget: jest.fn(), encryptJson: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn(), getOrThrow: jest.fn() } },
        { provide: 'IFileStorage', useValue: {} },
        { provide: PartnerCompanyExternService, useValue: { issue: jest.fn() } },
        { provide: SsgEventService, useValue: ssgEventServiceMock },
        { provide: UserManagementService, useValue: { deductBalance: jest.fn(), addBalance: jest.fn() } },
        { provide: DeliverySendService, useValue: { markSendSuccess: jest.fn(), markSendFail: jest.fn(), buildSmsText: jest.fn(), sendSms: jest.fn(), sendAlimTalk: jest.fn(), sendEmail: jest.fn() } },
        { provide: RefundLedgerService, useValue: { exists: jest.fn(), claim: jest.fn(), release: jest.fn(), isSsgSettled: jest.fn(), markSsgSettled: jest.fn(), getLedgerId: jest.fn() } },
        { provide: SsgInsertStateService, useValue: { getState: jest.fn() } },
        { provide: SsgRefundResolverService, useValue: { resolveAndRefundIfNeeded: jest.fn().mockResolvedValue('RESTORED') } },
        { provide: WalletManagedPredicate, useValue: { isWalletManaged: jest.fn() } },
        { provide: RefundPoolService, useValue: { refund: jest.fn(), reverseRefund: jest.fn() } },
        { provide: ResendDeductService, useValue: { resendDeduct: jest.fn(), resendUndo: jest.fn() } },
        { provide: getRepositoryToken(OrderDeliveryAttemptEntity), useValue: { findOne: jest.fn(), save: jest.fn() } },
        { provide: getRepositoryToken(OrderPaymentRefundEventEntity), useValue: { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() } },
        { provide: getRepositoryToken(OrderPaymentAllocationEntity), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(OrderHistoryEntity), useValue: {} },
        { provide: getDataSourceToken(), useValue: { transaction: jest.fn() } },
        { provide: OrderFromService, useValue: { resolveSendDefaultPhone: jest.fn() } },
      ],
    }).compile();

    service = module.get(DeliveryBatchService);
    ssgEventService = module.get(SsgEventService) as jest.Mocked<SsgEventService>;
    ssgRefundResolverService = module.get(SsgRefundResolverService) as jest.Mocked<SsgRefundResolverService>;
  });

  describe('reverseSsgReissueDeduct', () => {
    it('resolver outcome 을 그대로 반환', async () => {
      const od = { id: 99 } as OrderDeliveryEntity;
      const resolveSpy = jest
        .spyOn(ssgRefundResolverService, 'resolveAndRefundIfNeeded')
        .mockResolvedValue(SsgRefundOutcome.RESTORED);

      const outcome = await service.reverseSsgReissueDeduct(od, 7, 10000, 42, 'ULID123');

      expect(outcome).toBe(SsgRefundOutcome.RESTORED);
      expect(resolveSpy).toHaveBeenCalledWith({
        orderDeliveryId: 99,
        ssgEventId: 7,
        refundAmount: 10000,
        orderId: 42,
        resendDeductionId: 'ULID123',
      });
    });
  });

  describe('selectAndDeductSsgEventForReissue', () => {
    it('발급가능 행사 있으면 선차감(deductForReissueWithPending) + resendDeductionId 반환', async () => {
      const event = { id: 7, eventBalance: 100000 } as SsgEventEntity;
      jest.spyOn(ssgEventService, 'selectEventForOrder').mockResolvedValue(event);
      const deductSpy = jest
        .spyOn(ssgEventService, 'deductForReissueWithPending')
        .mockResolvedValue({ resendDeductionId: 'ULID-X' });

      const result = await service.selectAndDeductSsgEventForReissue(42, 10000, 30);

      expect(result).not.toBeNull();
      expect(result!.event.id).toBe(7);
      expect(result!.resendDeductionId).toBe('ULID-X');
      // CS 경로: 선차감 시점 신규 delivery 미존재 → issueOrderDeliveryId=null, purpose=CS_REISSUE.
      expect(deductSpy).toHaveBeenCalledWith({
        ssgEventId: 7,
        amount: 10000,
        orderId: 42,
        purpose: 'CS_REISSUE',
        issueOrderDeliveryId: null,
      });
    });

    it('발급가능 행사 없으면 null 반환, 차감 안 함', async () => {
      jest.spyOn(ssgEventService, 'selectEventForOrder').mockResolvedValue(null);
      const deductSpy = jest.spyOn(ssgEventService, 'deductForReissueWithPending');

      const result = await service.selectAndDeductSsgEventForReissue(42, 10000, 30);

      expect(result).toBeNull();
      expect(deductSpy).not.toHaveBeenCalled();
    });
  });
});
