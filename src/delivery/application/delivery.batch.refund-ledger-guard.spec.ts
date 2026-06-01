// typeorm-transactional 데코레이터를 no-op으로 mock (실제 DB 트랜잭션 없음)
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, _descriptor: unknown) => _descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { BadRequestException } from '@nestjs/common';
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
import { WalletManagedPredicate } from '../../wallet/application/wallet-managed.predicate';
import { RefundPoolService } from '../../wallet/application/refund-pool.service';
import { ResendDeductService } from '../../wallet/application/resend-deduct.service';
import { OrderDeliveryAttemptEntity } from '../../entity/order.delivery.attempt.entity';
import { OrderPaymentRefundEventEntity } from '../../entity/order.payment.refund.event.entity';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';

/**
 * 이번 핫픽스 회귀 테스트:
 *
 * 장애 조건:
 * - orderDelivery.refundedAt 컬럼이 다른 save/update 흐름에서 NULL로 덮어쓰일 수 있음
 * - 그래서 재발송 시 환불 발생 판정의 신뢰 가능한 단일 소스는
 *   order_delivery_refund ledger row 존재 여부
 *
 * 가드 변경:
 *  (A) delivery.batch.service.ts: SSG FAIL 재발송 시 새 행사 선차감 가드
 *      → ledger 있을 때만 deductEventBalance() 호출
 *  (B) delivery.batch.service.ts: reverseRefundForResend 가드
 *      → ledger 있을 때만 reverseRefundForResend() 호출 (그 안에서
 *        chargeBackForResend 또는 user balance 차감 + ledger release)
 *
 * 두 가드 모두 향후 refundedAt 의존으로 돌아가지 못하도록 잠근다.
 */
describe('DeliveryBatchService.reissuePinAndCreateImageIfNeeded - refund ledger guard', () => {
  let sut: DeliveryBatchService;
  let refundLedgerService: jest.Mocked<RefundLedgerService>;
  let ssgEventService: jest.Mocked<SsgEventService>;
  let partnerCompanyExternService: jest.Mocked<PartnerCompanyExternService>;
  let userManagementService: jest.Mocked<UserManagementService>;
  let ssgEventRepository: jest.Mocked<Repository<SsgEventEntity>>;
  let ssgInsertStateService: { getState: jest.Mock };
  let ssgRefundResolverService: { resolveAndRefundIfNeeded: jest.Mock };

  const ssgEvent = {
    id: 36,
    eventBalance: 10_000_000,
    eventPrice: 100_000_000,
  } as unknown as SsgEventEntity;

  // status=FAIL + barCode=null → 가드(A) 새 행사 선차감 경로
  const buildFailNoBarCode = (): OrderDeliveryEntity => ({
    id: 530931,
    status: IOrderDeliveryStatus.FAIL,
    deliveryMethod: IOrderSendMethod.MMS,
    ssgEventId: 36,
    barCode: null,
    refundedAt: null,
    imagePath: 'mock-image.png', // createCouponImage 경로 차단용
    orderProductMapping: {
      id: 1,
      order: {
        id: 4145,
        type: IOrderType.SSG,
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
        partnerCompany: { type: 'SSG' },
      },
    },
  } as unknown as OrderDeliveryEntity);

  // status=WAIT + barCode=null → 가드(B) reverseRefundForResend 경로 (선차감 안 일어남)
  const buildWaitNoBarCode = (): OrderDeliveryEntity => ({
    ...buildFailNoBarCode(),
    status: IOrderDeliveryStatus.WAIT,
  } as unknown as OrderDeliveryEntity);

  beforeEach(async () => {
    jest.clearAllMocks();

    refundLedgerService = {
      exists: jest.fn(),
      claim: jest.fn(),
      release: jest.fn(),
      // PR3 보강 — SSG 보정 완료 신호. 기본 true (보정 완료된 정상 흐름 가정).
      isSsgSettled: jest.fn().mockResolvedValue(true),
      markSsgSettled: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RefundLedgerService>;

    ssgEventService = {
      selectEventForOrder: jest.fn().mockResolvedValue(ssgEvent),
      deductEventBalance: jest.fn(),
      chargeBackForResend: jest.fn(),
      refundForDeliveryFail: jest.fn(),
    } as unknown as jest.Mocked<SsgEventService>;

    partnerCompanyExternService = {
      issue: jest.fn().mockImplementation(async (od: OrderDeliveryEntity) => {
        od.barCode = '80000000';
      }),
    } as unknown as jest.Mocked<PartnerCompanyExternService>;

    userManagementService = {
      deductBalance: jest.fn(),
      addBalance: jest.fn(),
    } as unknown as jest.Mocked<UserManagementService>;

    const userRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        setParameters: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({}),
      }),
    } as unknown as Repository<UserEntity>;

    ssgEventRepository = {
      findOne: jest.fn().mockResolvedValue(ssgEvent),
    } as unknown as jest.Mocked<Repository<SsgEventEntity>>;

    // PR3 — state 신호 mock. 기본 NONE (가드 통과). 케이스별 override.
    ssgInsertStateService = {
      getState: jest.fn().mockResolvedValue(SsgInsertState.NONE),
    };
    // shared resolver는 본 spec 케이스에서는 호출 자체를 검증하지 않으므로 jest.fn 만.
    ssgRefundResolverService = {
      resolveAndRefundIfNeeded: jest.fn().mockResolvedValue('RESTORED'),
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
        { provide: getRepositoryToken(SsgEventEntity), useValue: ssgEventRepository },
        { provide: 'DeliveryAlimTalk', useValue: {} },
        { provide: 'IMailSend', useValue: {} },
        { provide: 'ISmsSend', useValue: {} },
        { provide: DeliveryTrackHttp, useValue: {} },
        { provide: CryptoCipher, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: 'IFileStorage', useValue: {} },
        { provide: PartnerCompanyExternService, useValue: partnerCompanyExternService },
        { provide: SsgEventService, useValue: ssgEventService },
        { provide: UserManagementService, useValue: userManagementService },
        { provide: DeliverySendService, useValue: {} },
        { provide: RefundLedgerService, useValue: refundLedgerService },
        { provide: SsgInsertStateService, useValue: ssgInsertStateService },
        { provide: SsgRefundResolverService, useValue: ssgRefundResolverService },
        // PR2-006 wallet hook DI — default non-wallet path (isWalletManaged=false)
        { provide: WalletManagedPredicate, useValue: { isWalletManaged: jest.fn().mockResolvedValue(false) } },
        { provide: RefundPoolService, useValue: { refund: jest.fn(), reverseRefund: jest.fn() } },
        { provide: ResendDeductService, useValue: { resendDeduct: jest.fn(), resendUndo: jest.fn() } },
        { provide: getRepositoryToken(OrderDeliveryAttemptEntity), useValue: { findOne: jest.fn(), save: jest.fn() } },
        { provide: getRepositoryToken(OrderPaymentRefundEventEntity), useValue: { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() } },
        { provide: getRepositoryToken(OrderPaymentAllocationEntity), useValue: { findOne: jest.fn() } },
        { provide: getDataSourceToken(), useValue: { transaction: jest.fn() } },
      ],
    }).compile();

    sut = module.get(DeliveryBatchService);
  });

  describe('가드(A) SSG FAIL 재발송 - 새 행사 선차감', () => {
    it('refundedAt이 null이어도 refund ledger가 있으면 새 행사 선차감이 발생한다', async () => {
      const od = buildFailNoBarCode();
      refundLedgerService.exists.mockResolvedValue(true);

      const result = await (sut as any).reissuePinAndCreateImageIfNeeded(od);

      expect(result).toBe(true);
      expect(refundLedgerService.exists).toHaveBeenCalledWith(od.id);
      // ledger row 있음 → 새 행사 선차감 진행
      expect(ssgEventService.selectEventForOrder).toHaveBeenCalled();
      expect(ssgEventService.deductEventBalance).toHaveBeenCalledWith(
        ssgEvent.id,
        10_000,
        4145,
        false,
      );
    });

    it('refund ledger 없음 + state=NONE → 새 선차감 X + warn 로그 (비정상 케이스 감지)', async () => {
      const od = buildFailNoBarCode();
      refundLedgerService.exists.mockResolvedValue(false);
      ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.NONE);
      const warnSpy = jest.spyOn((sut as any).logger, 'warn');

      const result = await (sut as any).reissuePinAndCreateImageIfNeeded(od);

      expect(result).toBe(true);
      // ledger row 없음 = 환불 이력 없음 = 선차감하면 이중차감
      expect(ssgEventService.selectEventForOrder).not.toHaveBeenCalled();
      expect(ssgEventService.deductEventBalance).not.toHaveBeenCalled();
      // 정상 흐름이라면 status=FAIL 이면 refundForFail() 이 호출되어 ledger 있어야 함.
      // 비정상 케이스 — 운영 조사 대상이므로 warn 로그 필수.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('환불 ledger 누락 또는 local SSG 차감 잔존'),
      );
    });

    /**
     * PR3.B — state CONFIRMED 면 ledger 가 있어도 새 선차감 X.
     * CONFIRMED = SSG 등록 확정 → 기존 PIN 재사용해야지 새 행사로 옮기면 이중 차감.
     * 두 신호 (ledger + state) AND 가드의 핵심 케이스.
     */
    it('refund ledger 있어도 state=CONFIRMED 면 새 행사 선차감을 하지 않는다 (PR3.B)', async () => {
      const od = buildFailNoBarCode();
      refundLedgerService.exists.mockResolvedValue(true);
      ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.CONFIRMED);

      const result = await (sut as any).reissuePinAndCreateImageIfNeeded(od);

      expect(result).toBe(true);
      expect(ssgEventService.selectEventForOrder).not.toHaveBeenCalled();
      expect(ssgEventService.deductEventBalance).not.toHaveBeenCalled();
    });

    it('ledger 없음 + state=CONFIRMED → 아무 보정 안 함, warn 도 없음 (정상 — 이미 발송됨)', async () => {
      const od = buildFailNoBarCode();
      refundLedgerService.exists.mockResolvedValue(false);
      ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.CONFIRMED);
      const warnSpy = jest.spyOn((sut as any).logger, 'warn');

      const result = await (sut as any).reissuePinAndCreateImageIfNeeded(od);

      expect(result).toBe(true);
      expect(ssgEventService.selectEventForOrder).not.toHaveBeenCalled();
      expect(ssgEventService.deductEventBalance).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('환불 ledger 누락'),
      );
    });

    /**
     * PR3 보강 — ledger=true + state=NONE/FAILED 이어도 ssg_balance_settled=false 면 새 선차감 차단.
     * 이전 refundForFail 의 SSG resolver 가 DEFERRED 반환했을 경우 후속 가드에서 이중 차감 방지.
     */
    it('ledger=true + state=NONE + ssg_balance_settled=false → 새 선차감 차단 + error 로그', async () => {
      const od = buildFailNoBarCode();
      refundLedgerService.exists.mockResolvedValue(true);
      (refundLedgerService.isSsgSettled as jest.Mock).mockResolvedValue(false);
      ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.NONE);
      const errorSpy = jest.spyOn((sut as any).logger, 'error');

      const result = await (sut as any).reissuePinAndCreateImageIfNeeded(od);

      expect(result).toBe(true);
      expect(ssgEventService.selectEventForOrder).not.toHaveBeenCalled();
      expect(ssgEventService.deductEventBalance).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('SSG 잔액 보정 미완료'),
      );
    });
  });

  describe('가드(B) reverseRefundForResend - 선차감 안 일어나는 케이스', () => {
    it('refundedAt이 null이어도 refund ledger가 있으면 chargeBackForResend가 호출된다', async () => {
      const od = buildWaitNoBarCode();
      refundLedgerService.exists.mockResolvedValue(true);

      const result = await (sut as any).reissuePinAndCreateImageIfNeeded(od);

      expect(result).toBe(true);
      // status=WAIT라 가드(A) 미진입 → 선차감 안 일어남 → reverseRefundForResend(skipSsg=false)
      expect(ssgEventService.deductEventBalance).not.toHaveBeenCalled();
      expect(ssgEventService.chargeBackForResend).toHaveBeenCalled();
      // 고객사 환불 역처리도 같이 진행
      expect(refundLedgerService.release).toHaveBeenCalledWith(od.id);
    });

    it('refund ledger가 없으면 chargeBackForResend가 호출되지 않는다', async () => {
      const od = buildWaitNoBarCode();
      refundLedgerService.exists.mockResolvedValue(false);

      const result = await (sut as any).reissuePinAndCreateImageIfNeeded(od);

      expect(result).toBe(true);
      expect(ssgEventService.chargeBackForResend).not.toHaveBeenCalled();
      expect(refundLedgerService.release).not.toHaveBeenCalled();
    });

    /**
     * PR3.B 핵심 — 신호 분리.
     * state CONFIRMED + ledger exists → 고객사 환불 역처리(release)는 진행하되 SSG chargeBack은 skip.
     * (CONFIRMED 는 SSG 등록 확정 상태이므로 행사 잔액을 손대지 않는다.)
     */
    it('state CONFIRMED 면 ledger 있어도 chargeBackForResend skip, release는 호출된다 (신호 분리)', async () => {
      const od = buildWaitNoBarCode();
      refundLedgerService.exists.mockResolvedValue(true);
      ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.CONFIRMED);

      const result = await (sut as any).reissuePinAndCreateImageIfNeeded(od);

      expect(result).toBe(true);
      // SSG 행사 잔액은 손대지 않음
      expect(ssgEventService.chargeBackForResend).not.toHaveBeenCalled();
      // 고객사 환불 역처리는 진행 (ledger release)
      expect(refundLedgerService.release).toHaveBeenCalledWith(od.id);
    });

    /**
     * PR3 신호 분리 — SSG chargeBack 이 throw 해도 고객 재차감/ledger release 는 계속 진행.
     * SSG 보정 영역 실패가 고객 환불/역환불 영역을 막으면 안 된다.
     */
    it('SSG chargeBackForResend 가 throw 해도 release 와 deductBalance 는 호출된다 (신호 분리 격리)', async () => {
      const od = buildWaitNoBarCode();
      refundLedgerService.exists.mockResolvedValue(true);
      ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.NONE);
      ssgEventService.chargeBackForResend.mockRejectedValue(new Error('SSG event balance not found'));

      const result = await (sut as any).reissuePinAndCreateImageIfNeeded(od);

      expect(result).toBe(true);
      expect(ssgEventService.chargeBackForResend).toHaveBeenCalled();
      // SSG chargeBack 실패해도 고객 측 처리는 진행
      expect(refundLedgerService.release).toHaveBeenCalledWith(od.id);
      expect(userManagementService.deductBalance).toHaveBeenCalled();
    });

    /**
     * MEDIUM 3 — catch 축소. reverseRefundForResend 의 광범위 catch 가 release 중복 외의
     * BadRequest(여기선 release 전 단계인 deductBalance)까지 "중복 차단 정상"으로 삼켜
     * @Transactional 이 부분 wallet 상태를 commit + resend 를 '성공(true)'으로 보고하던 문제.
     * 수정 후: 해당 BadRequest 는 reverseRefundForResend 밖으로 전파 → @Transactional 롤백 →
     * 상위 catch 가 받아 resend 를 '실패(false)'로 보고. 잘못된 성공 보고 + 부분 커밋이 사라진다.
     */
    it('release 외 단계(deductBalance)의 BadRequestException 은 중복으로 흡수되지 않아 resend 가 false 로 보고된다', async () => {
      const od = buildWaitNoBarCode();
      refundLedgerService.exists.mockResolvedValue(true);
      ssgInsertStateService.getState.mockResolvedValue(SsgInsertState.NONE);
      userManagementService.deductBalance.mockRejectedValue(new BadRequestException('잔액 부족'));

      const result = await (sut as any).reissuePinAndCreateImageIfNeeded(od);

      // 과거엔 내부 catch 가 삼켜 true 반환. 이제 전파 → 상위 catch → false.
      expect(result).toBe(false);
      // deductBalance(release 전 단계)에서 throw → release 도달 안 함
      expect(refundLedgerService.release).not.toHaveBeenCalled();
    });
  });

  /**
   * race 회귀: 두 가드 사이 issue() 실행 중 다른 흐름이 ledger를 release할 수 있다.
   * 첫 조회(가드 A)에서 true였더라도 두 번째 조회(가드 B) 시점엔 false여야 한다.
   * 캐시된 boolean 재사용을 막기 위해 각 가드는 별도로 exists()를 호출해야 한다.
   */
  describe('race: issue() 중 다른 흐름이 ledger를 release한 경우', () => {
    it('exists() 첫 호출 true + 두 번째 호출 false이면 reverseRefundForResend가 호출되지 않는다', async () => {
      const od = buildWaitNoBarCode();
      refundLedgerService.exists
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const result = await (sut as any).reissuePinAndCreateImageIfNeeded(od);

      expect(result).toBe(true);
      // exists()가 두 번 호출되어야 한다 (캐시 재사용 금지)
      expect(refundLedgerService.exists).toHaveBeenCalledTimes(2);
      // 두 번째 호출에서 false 받으므로 reverseRefundForResend 트리거 안 됨
      expect(ssgEventService.chargeBackForResend).not.toHaveBeenCalled();
      expect(refundLedgerService.release).not.toHaveBeenCalled();
    });
  });
});
