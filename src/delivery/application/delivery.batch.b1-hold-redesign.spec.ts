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
import { Repository } from 'typeorm';
import { DeliverySendHistoryEntity } from '../../entity/delivery.send.history.entity';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderEntity } from '../../entity/order.entity';
import { OrderRealProductEntity } from '../../entity/order.real.product.entity';
import { OrderRealProductMappingEntity } from '../../entity/order.real.product.mapping.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { UserEntity } from '../../entity/user.entity';
import {
  OrderDeliveryAttemptEntity,
  OrderDeliveryAttemptType,
  OrderDeliveryAttemptStatus,
} from '../../entity/order.delivery.attempt.entity';
import { OrderPaymentRefundEventEntity } from '../../entity/order.payment.refund.event.entity';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { OrderHistoryEntity } from '../../entity/order.history.entity';
import { IOrderSendMethod } from '../../order/interface/order.send.method';
import { IOrderType } from '../../order/interface/order.type';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';
import { UserManagementService } from '../../user_management/application/user.management.service';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { DeliveryTrackHttp } from '../infra/delivery.track.http';
import { IOrderDeliveryStatus } from '../interface/order.delivery.status';
import { SsgInsertState } from '../interface/ssg.insert.state';
import { DeliveryBatchService } from './delivery.batch.service';
import { DeliverySendService } from './delivery.send.service';
import { RefundLedgerService } from './refund-ledger.service';
import { SsgInsertStateService } from './ssg-insert-state.service';
import { SsgRefundResolverService } from './ssg-refund.resolver';
import { OrderFromService } from '../../order_from/application/order.from.service';
import { WalletManagedPredicate } from '../../wallet/application/wallet-managed.predicate';
import { RefundPoolService } from '../../wallet/application/refund-pool.service';
import { ResendDeductService } from '../../wallet/application/resend-deduct.service';
import { LegacyWalletCreditSyncService } from '../../wallet/application/legacy-wallet-credit-sync.service';

/**
 * B1: 정산 복구 이벤트 미생성(초기 발송 실패 보류) redesign 회귀 테스트.
 *
 * 핵심 정책 (plans/02_settlement-hold-redesign.md §B1):
 *  1) 비-SSG 최초 발송 실패 = 구매/발송 미성립 → refundForFail 미호출(보류, 차감 유지).
 *  2) SSG / 재발송 실패는 기존대로 환불.
 *  3) 보류 재발송(exists=false, wallet) → RESEND attempt slot 선발급(재실패 cycle 정확).
 *  4) 환불됨 재발송(exists=true) → reverse 가 needsIssue=false 로 skip 되면 명시 호출로 보강.
 */
describe('DeliveryBatchService - B1 settlement-hold redesign', () => {
  let sut: DeliveryBatchService;
  let refundLedgerService: jest.Mocked<RefundLedgerService>;
  let walletManagedPredicate: { isWalletManaged: jest.Mock };
  let attemptRepository: { findOne: jest.Mock; save: jest.Mock };
  let userManagementService: jest.Mocked<UserManagementService>;
  let smsSend: { send: jest.Mock };
  let deliverySendService: {
    markSendSuccess: jest.Mock;
    markSendFail: jest.Mock;
    buildSmsText: jest.Mock;
    sendSms: jest.Mock;
    sendAlimTalk: jest.Mock;
    sendEmail: jest.Mock;
  };
  let partnerCompanyExternService: jest.Mocked<PartnerCompanyExternService>;
  let ssgInsertStateService: { getState: jest.Mock };

  // smsSend.send 가 status 를 직접 바꾸지 않으므로 markSend* mock 으로 status 를 세팅한다.
  const wireStatusMarkers = () => {
    deliverySendService.markSendSuccess.mockImplementation((od: OrderDeliveryEntity, status: IOrderDeliveryStatus) => {
      od.status = status;
    });
    deliverySendService.markSendFail.mockImplementation((od: OrderDeliveryEntity, status: IOrderDeliveryStatus) => {
      od.status = status;
    });
  };

  const buildDelivery = (over: Partial<OrderDeliveryEntity> = {}): OrderDeliveryEntity =>
    ({
      id: 770001,
      status: IOrderDeliveryStatus.WAIT,
      deliveryMethod: IOrderSendMethod.MMS,
      barCode: '80000000',
      imagePath: 'mock-image.png',
      ssgEventId: null,
      transactionId: 'tx-1',
      deliveryTarget: 'enc-target',
      expireAt: new Date('2026-01-01'),
      emailReceiverPhone: null,
      orderProductMapping: {
        id: 1,
        sendTitle: '제목',
        sendContent: '내용',
        sendTailText: null,
        fromPhoneNumber: '0212345678',
        galaxiaDuration: null,
        encourageDay: null,
        order: {
          id: 9001,
          type: IOrderType.GENERAL,
          isSettleComplete: false,
          isSettleBalance: true,
          cardSurchargeApplied: false,
          clientUserId: null,
          user: { id: 100 },
        },
        product: {
          id: 1,
          price: 10_000,
          expireDay: 60,
          type: 'NORMAL',
          memo: null,
          partnerCompany: { type: 'NORMAL' },
        },
      },
      ...over,
    }) as unknown as OrderDeliveryEntity;

  beforeEach(async () => {
    jest.clearAllMocks();

    refundLedgerService = {
      exists: jest.fn().mockResolvedValue(false),
      claim: jest.fn(),
      release: jest.fn(),
      isSsgSettled: jest.fn().mockResolvedValue(true),
      markSsgSettled: jest.fn().mockResolvedValue(undefined),
      getLedgerId: jest.fn().mockResolvedValue(123),
    } as unknown as jest.Mocked<RefundLedgerService>;

    walletManagedPredicate = { isWalletManaged: jest.fn().mockResolvedValue(false) };
    attemptRepository = { findOne: jest.fn(), save: jest.fn() };

    userManagementService = {
      deductBalance: jest.fn(),
      addBalance: jest.fn(),
    } as unknown as jest.Mocked<UserManagementService>;

    smsSend = { send: jest.fn().mockResolvedValue(undefined) };

    deliverySendService = {
      markSendSuccess: jest.fn(),
      markSendFail: jest.fn(),
      buildSmsText: jest.fn().mockReturnValue('sms-text'),
      sendSms: jest.fn(),
      sendAlimTalk: jest.fn(),
      sendEmail: jest.fn(),
    };
    wireStatusMarkers();

    partnerCompanyExternService = {
      issue: jest.fn().mockImplementation(async (od: OrderDeliveryEntity) => {
        od.barCode = '80000000';
        return { ssgNewIssue: true, ssgEventId: od.ssgEventId ?? null };
      }),
    } as unknown as jest.Mocked<PartnerCompanyExternService>;

    ssgInsertStateService = { getState: jest.fn().mockResolvedValue(SsgInsertState.NONE) };

    const cryptoCipher = {
      safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01012345678'),
      decryptDeliveryTarget: jest.fn().mockReturnValue('01012345678'),
      encryptDeliveryTarget: jest.fn().mockReturnValue('ENC'),
      encryptJson: jest.fn().mockReturnValue('enc-key'),
    };

    const userRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        setParameters: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({}),
      }),
    } as unknown as Repository<UserEntity>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryBatchService,
        { provide: getRepositoryToken(OrderEntity), useValue: {} },
        { provide: getRepositoryToken(OrderRealProductEntity), useValue: {} },
        { provide: getRepositoryToken(OrderRealProductMappingEntity), useValue: {} },
        {
          provide: getRepositoryToken(OrderDeliveryEntity),
          useValue: { update: jest.fn(), save: jest.fn(), manager: {} },
        },
        { provide: getRepositoryToken(DeliverySendHistoryEntity), useValue: { save: jest.fn() } },
        { provide: getRepositoryToken(EmailSendHistoryEntity), useValue: {} },
        { provide: getRepositoryToken(UserEntity), useValue: userRepo },
        { provide: getRepositoryToken(SsgEventEntity), useValue: { findOne: jest.fn() } },
        { provide: 'DeliveryAlimTalk', useValue: {} },
        { provide: 'IMailSend', useValue: {} },
        { provide: 'ISmsSend', useValue: smsSend },
        { provide: DeliveryTrackHttp, useValue: {} },
        { provide: CryptoCipher, useValue: cryptoCipher },
        { provide: ConfigService, useValue: { get: jest.fn(), getOrThrow: jest.fn() } },
        { provide: 'IFileStorage', useValue: {} },
        { provide: PartnerCompanyExternService, useValue: partnerCompanyExternService },
        {
          provide: SsgEventService,
          useValue: { selectEventForOrder: jest.fn(), deductEventBalance: jest.fn(), chargeBackForResend: jest.fn() },
        },
        { provide: UserManagementService, useValue: userManagementService },
        { provide: DeliverySendService, useValue: deliverySendService },
        { provide: RefundLedgerService, useValue: refundLedgerService },
        { provide: SsgInsertStateService, useValue: ssgInsertStateService },
        {
          provide: SsgRefundResolverService,
          useValue: { resolveAndRefundIfNeeded: jest.fn().mockResolvedValue('RESTORED') },
        },
        { provide: WalletManagedPredicate, useValue: walletManagedPredicate },
        { provide: RefundPoolService, useValue: { refund: jest.fn(), reverseRefund: jest.fn() } },
        { provide: ResendDeductService, useValue: { resendDeduct: jest.fn(), resendUndo: jest.fn() } },
        { provide: LegacyWalletCreditSyncService, useValue: { syncCredit: jest.fn() } },
        { provide: getRepositoryToken(OrderDeliveryAttemptEntity), useValue: attemptRepository },
        {
          provide: getRepositoryToken(OrderPaymentRefundEventEntity),
          useValue: { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() },
        },
        { provide: getRepositoryToken(OrderPaymentAllocationEntity), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(OrderHistoryEntity), useValue: {} },
        { provide: getDataSourceToken(), useValue: { transaction: jest.fn() } },
        { provide: OrderFromService, useValue: { resolveSendDefaultPhone: jest.fn().mockResolvedValue('16443614') } },
      ],
    }).compile();

    sut = module.get(DeliveryBatchService);
  });

  describe('최초 발송 실패 보류 (processOneDeliveryInternal)', () => {
    it('비-SSG 최초 발송 실패 → refundForFail 미호출 (보류, ledger.claim 안 됨)', async () => {
      const od = buildDelivery({ status: IOrderDeliveryStatus.WAIT });
      // 발송 실패 시뮬레이션 — sendSms 가 status 를 FAIL 로 마킹.
      deliverySendService.sendSms.mockImplementation(async (d: OrderDeliveryEntity) => {
        d.status = IOrderDeliveryStatus.FAIL;
      });

      await (sut as any).processOneDeliveryInternal(od);

      expect(od.status).toBe(IOrderDeliveryStatus.FAIL);
      // 보류 = refundForFail 미호출 → ledger.claim 안 됨
      expect(refundLedgerService.claim).not.toHaveBeenCalled();
    });

    it('SSG 최초 발송 실패 + state=NONE → refundForFail 미호출 (B3 보류)', async () => {
      const od = buildDelivery({ status: IOrderDeliveryStatus.WAIT, ssgEventId: 36 });
      (od.orderProductMapping.order as any).type = IOrderType.SSG;
      ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.NONE);
      deliverySendService.sendSms.mockImplementation(async (d: OrderDeliveryEntity) => {
        d.status = IOrderDeliveryStatus.FAIL;
      });

      await (sut as any).processOneDeliveryInternal(od);

      // B3: 행사잔액 주문시점 차감 → 최초실패 보류(고객+행사 유지). refundForFail 미호출.
      expect(refundLedgerService.claim).not.toHaveBeenCalled();
    });

    it('SSG 최초 발송 실패 + state=CONFIRMED → refundForFail 미호출 (B3 보류, PIN 등록됨 메시지만 실패)', async () => {
      const od = buildDelivery({ status: IOrderDeliveryStatus.WAIT, ssgEventId: 36 });
      (od.orderProductMapping.order as any).type = IOrderType.SSG;
      ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.CONFIRMED);
      deliverySendService.sendSms.mockImplementation(async (d: OrderDeliveryEntity) => {
        d.status = IOrderDeliveryStatus.FAIL;
      });

      await (sut as any).processOneDeliveryInternal(od);

      expect(refundLedgerService.claim).not.toHaveBeenCalled();
    });

    it('SSG 최초 발송 실패 + state=ATTEMPTED → refundForFail 호출 (보류 제외, resolver 경로)', async () => {
      const od = buildDelivery({ status: IOrderDeliveryStatus.WAIT, ssgEventId: 36 });
      (od.orderProductMapping.order as any).type = IOrderType.SSG;
      ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.ATTEMPTED);
      deliverySendService.sendSms.mockImplementation(async (d: OrderDeliveryEntity) => {
        d.status = IOrderDeliveryStatus.FAIL;
      });

      await (sut as any).processOneDeliveryInternal(od);

      // ATTEMPTED(INSERT 응답 미확정)는 보류 제외 → 기존 refundForFail→resolver.
      expect(refundLedgerService.claim).toHaveBeenCalled();
    });

    it('비-SSG 재발송(진입 status=FAIL) 실패 → refundForFail 호출 (재발송은 환불)', async () => {
      const od = buildDelivery({ status: IOrderDeliveryStatus.FAIL });
      deliverySendService.sendSms.mockImplementation(async (d: OrderDeliveryEntity) => {
        d.status = IOrderDeliveryStatus.FAIL;
      });

      await (sut as any).processOneDeliveryInternal(od);

      expect(refundLedgerService.claim).toHaveBeenCalled();
    });

    it('비-SSG 최초 발송 성공 → refundForFail 미호출 (정상 발송)', async () => {
      const od = buildDelivery({ status: IOrderDeliveryStatus.WAIT });
      deliverySendService.sendSms.mockImplementation(async (d: OrderDeliveryEntity) => {
        d.status = IOrderDeliveryStatus.COMPLETE;
      });

      await (sut as any).processOneDeliveryInternal(od);

      expect(refundLedgerService.claim).not.toHaveBeenCalled();
    });
  });

  describe('보류 재발송 RESEND attempt slot 선발급 (oneSend)', () => {
    it('held wallet 재발송(FAIL+exists=false+wallet) → RESEND attempt slot 발급, reverse 미실행', async () => {
      const od = buildDelivery({ status: IOrderDeliveryStatus.FAIL });
      refundLedgerService.exists.mockResolvedValue(false);
      walletManagedPredicate.isWalletManaged.mockResolvedValue(true);

      const result = await sut.oneSend(od);

      expect(result).toBe(true);
      // 보류 재발송 → RESEND attempt slot 선발급
      expect(attemptRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          orderDeliveryId: od.id,
          attemptType: OrderDeliveryAttemptType.RESEND,
          status: OrderDeliveryAttemptStatus.DEDUCTED,
        }),
      );
      // 환불 미생성 상태이므로 reverse(=ledger release) 는 일어나면 안 됨
      expect(refundLedgerService.release).not.toHaveBeenCalled();
    });

    it('SSG held wallet 재발송(FAIL+exists=false+wallet) → RESEND attempt slot 발급 (B3)', async () => {
      const od = buildDelivery({ status: IOrderDeliveryStatus.FAIL, ssgEventId: 36 });
      (od.orderProductMapping.order as any).type = IOrderType.SSG;
      refundLedgerService.exists.mockResolvedValue(false);
      walletManagedPredicate.isWalletManaged.mockResolvedValue(true);
      ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.NONE);

      await sut.oneSend(od);

      // B3: SSG held resend(wallet)도 slot 발급 — 미발급 시 cycle 이 INITIAL 로 떨어져 환불 누락.
      expect(attemptRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptType: OrderDeliveryAttemptType.RESEND,
          status: OrderDeliveryAttemptStatus.DEDUCTED,
        }),
      );
      // 보류라 reverse(ledger release) 미실행
      expect(refundLedgerService.release).not.toHaveBeenCalled();
    });

    it('테스트 발송(testOrderDeliveryId)은 RESEND attempt slot 을 발급하지 않는다', async () => {
      const od = buildDelivery({ status: IOrderDeliveryStatus.FAIL });
      refundLedgerService.exists.mockResolvedValue(false);
      walletManagedPredicate.isWalletManaged.mockResolvedValue(true);

      await sut.oneSend(od, true, 99999);

      expect(attemptRepository.save).not.toHaveBeenCalled();
    });

    it('성공건 재발송(status=COMPLETE)은 RESEND attempt slot 을 발급하지 않는다', async () => {
      const od = buildDelivery({ status: IOrderDeliveryStatus.COMPLETE });
      refundLedgerService.exists.mockResolvedValue(false);
      walletManagedPredicate.isWalletManaged.mockResolvedValue(true);

      await sut.oneSend(od);

      expect(attemptRepository.save).not.toHaveBeenCalled();
    });

    it('legacy held 재발송(wallet 아님)은 attempt slot 발급 없이 발송만 진행', async () => {
      const od = buildDelivery({ status: IOrderDeliveryStatus.FAIL });
      refundLedgerService.exists.mockResolvedValue(false);
      walletManagedPredicate.isWalletManaged.mockResolvedValue(false);

      const result = await sut.oneSend(od);

      expect(result).toBe(true);
      expect(attemptRepository.save).not.toHaveBeenCalled();
      expect(refundLedgerService.release).not.toHaveBeenCalled();
    });
  });

  describe('환불됨 재발송 reverse 보강 (oneSend, needsIssue=false)', () => {
    it('refunded 재발송(FAIL+exists=true+barCode 보유) → 명시 reverse 로 ledger release 보강', async () => {
      const od = buildDelivery({ status: IOrderDeliveryStatus.FAIL, barCode: '80000000', imagePath: 'mock-image.png' });
      // exists 는 항상 true (reissue 내부 reverse 가 skip 되어 release 안 됨 → oneSend 에서 보강)
      refundLedgerService.exists.mockResolvedValue(true);
      walletManagedPredicate.isWalletManaged.mockResolvedValue(false); // legacy mirror 경로

      const result = await sut.oneSend(od);

      expect(result).toBe(true);
      // needsIssue=false 라 reissue 내부 reverse 는 skip → oneSend 가 명시 호출 → release 보강
      expect(refundLedgerService.release).toHaveBeenCalledWith(od.id);
      // legacy mirror 잔액 복원
      expect(userManagementService.deductBalance).toHaveBeenCalled();
    });
  });

  describe('보류 재발송 reissue 실패 → 보류 유지 (oneSend)', () => {
    it('PIN 재발급 실패 → return false, attempt slot 미발급, 환불 미호출', async () => {
      const od = buildDelivery({ status: IOrderDeliveryStatus.FAIL, barCode: null, imagePath: null });
      refundLedgerService.exists.mockResolvedValue(false);
      walletManagedPredicate.isWalletManaged.mockResolvedValue(true);
      // issue() 가 barCode 를 채우지 못함 → PIN 재발급 실패
      partnerCompanyExternService.issue.mockImplementation(async () => {
        /* barCode 미설정 */
        return { ssgNewIssue: false, ssgEventId: null };
      });

      const result = await sut.oneSend(od);

      expect(result).toBe(false);
      // reissue 실패 = 발송 미성립 → slot 미발급, 환불 미호출 (보류 유지)
      expect(attemptRepository.save).not.toHaveBeenCalled();
      expect(refundLedgerService.claim).not.toHaveBeenCalled();
    });
  });
});
