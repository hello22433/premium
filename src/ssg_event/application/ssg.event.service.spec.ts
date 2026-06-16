jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, descriptor: PropertyDescriptor) => descriptor,
}));
import { BadRequestException } from '@nestjs/common';
import { SsgEventService } from './ssg.event.service';

describe('SsgEventService', () => {
  const createService = () => {
    const ssgEventRepository = {
      insert: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const amountHistoryRepository = {
      create: jest.fn((v) => v),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const orderProductMappingRepository = {};
    const reservationRangeRepository = {};
    const recoveryLogRepository = {
      createQueryBuilder: jest.fn(),
    };
    const resendDeductRecoveryRepository = {
      createQueryBuilder: jest.fn(),
    };
    const resendDeductPendingRepository = {
      createQueryBuilder: jest.fn(),
    };
    const refundLedgerRepository = {
      findOne: jest.fn(),
    };
    const activityLogService = {};
    const ssgIssue = {};

    const service = new SsgEventService(
      ssgEventRepository as any,
      amountHistoryRepository as any,
      orderProductMappingRepository as any,
      reservationRangeRepository as any,
      recoveryLogRepository as any,
      resendDeductRecoveryRepository as any,
      resendDeductPendingRepository as any,
      refundLedgerRepository as any,
      activityLogService as any,
      ssgIssue as any,
    );

    return {
      service,
      ssgEventRepository,
      amountHistoryRepository,
      recoveryLogRepository,
      resendDeductRecoveryRepository,
      refundLedgerRepository,
    };
  };

  /**
   * resendDeductRecovery INSERT 체인 mocking. resend_deduction_id 별 한 번만 성공, 재시도는 ER_DUP_ENTRY.
   */
  const mockResendDeductInsert = (resendDeductRecoveryRepository: any, seen: Set<string>) => {
    resendDeductRecoveryRepository.createQueryBuilder.mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn((v: { resendDeductionId: string }) => ({
        execute: jest.fn(() => {
          if (seen.has(v.resendDeductionId)) {
            const err: any = new Error('ER_DUP_ENTRY');
            err.code = 'ER_DUP_ENTRY';
            return Promise.reject(err);
          }
          seen.add(v.resendDeductionId);
          return Promise.resolve(undefined);
        }),
      })),
    });
  };

  /**
   * findSsgEventForUpdate 가 사용하는 lock query builder 체인을 mocking.
   * getOne() 이 주어진 event(또는 null) 을 반환하게 한다.
   */
  const mockFindSsgEvent = (ssgEventRepository: any, event: unknown) => {
    ssgEventRepository.createQueryBuilder.mockReturnValue({
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(event),
    });
  };

  /**
   * recoveryLog INSERT 체인을 mocking. refund_ledger_id 별로 한 번만 성공시키고
   * 두 번째부터는 ER_DUP_ENTRY 를 던져 DB UNIQUE 제약을 흉내낸다.
   */
  const mockRecoveryLogInsert = (recoveryLogRepository: any, seen: Set<number>) => {
    recoveryLogRepository.createQueryBuilder.mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn((v: { refundLedgerId: number }) => ({
        execute: jest.fn(() => {
          if (seen.has(v.refundLedgerId)) {
            const err: any = new Error('ER_DUP_ENTRY');
            err.code = 'ER_DUP_ENTRY';
            return Promise.reject(err);
          }
          seen.add(v.refundLedgerId);
          return Promise.resolve(undefined);
        }),
      })),
    });
  };

  describe('create', () => {
    const dto = {
      code: 'event-key',
      no: 'event-no',
      name: 'SSG event',
      startAt: '2026-05-01T00:00:00',
      endAt: '2026-05-31T00:00:00',
      couponExpiration: 60,
      eventPrice: 10000,
    } as any;

    it('행사 금액이 양의 정수가 아니면 거절한다', async () => {
      const { service, ssgEventRepository } = createService();

      await expect(service.create({ ...dto, eventPrice: 0 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.create({ ...dto, eventPrice: -1 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.create({ ...dto, eventPrice: 1.5 })).rejects.toBeInstanceOf(BadRequestException);

      expect(ssgEventRepository.insert).not.toHaveBeenCalled();
    });

    it('행사 금액을 초기 행사 잔액으로 저장한다', async () => {
      const { service, ssgEventRepository } = createService();

      await service.create(dto);

      expect(ssgEventRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          eventPrice: dto.eventPrice,
          eventBalance: dto.eventPrice,
        }),
      );
    });
  });

  describe('updateAmount', () => {
    it('충전 금액이 양의 정수가 아니면 이벤트 조회 전에 거절한다', async () => {
      const { service, ssgEventRepository } = createService();

      await expect(service.updateAmount({ id: 1, amount: 0 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.updateAmount({ id: 1, amount: -1 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.updateAmount({ id: 1, amount: 1.5 })).rejects.toBeInstanceOf(BadRequestException);

      expect(ssgEventRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('refundForDeliveryFail (멱등)', () => {
    it('동일 refund_ledger_id 로 2회 호출 → 잔액 1회만 증가, recovery_log 1행', async () => {
      const { service, ssgEventRepository, amountHistoryRepository, refundLedgerRepository, recoveryLogRepository } =
        createService();

      const ssgEvent = { id: 36, eventBalance: 100_000 };
      mockFindSsgEvent(ssgEventRepository, ssgEvent);
      refundLedgerRepository.findOne.mockResolvedValue({ id: 777 });

      const seen = new Set<number>();
      mockRecoveryLogInsert(recoveryLogRepository, seen);

      await service.refundForDeliveryFail(36, 4145, 10_000, 4145);
      await service.refundForDeliveryFail(36, 4145, 10_000, 4145);

      // 잔액은 1회만 증가
      expect(ssgEvent.eventBalance).toBe(110_000);
      expect(ssgEventRepository.save).toHaveBeenCalledTimes(1);
      expect(amountHistoryRepository.save).toHaveBeenCalledTimes(1);
      // recovery_log INSERT 는 1행만 성공
      expect(seen.size).toBe(1);
    });

    it('ssgEvent 없음 → throw, recovery_log 0행, 잔액 변화 0', async () => {
      const { service, ssgEventRepository, amountHistoryRepository, refundLedgerRepository, recoveryLogRepository } =
        createService();

      mockFindSsgEvent(ssgEventRepository, null);
      refundLedgerRepository.findOne.mockResolvedValue({ id: 777 });
      const seen = new Set<number>();
      mockRecoveryLogInsert(recoveryLogRepository, seen);

      await expect(service.refundForDeliveryFail(36, 4145, 10_000, 4145)).rejects.toThrow();

      expect(seen.size).toBe(0);
      expect(ssgEventRepository.save).not.toHaveBeenCalled();
      expect(amountHistoryRepository.save).not.toHaveBeenCalled();
    });

    it('ledger row 없음 → throw (claim 없이 호출된 비정상)', async () => {
      const { service, ssgEventRepository, refundLedgerRepository, recoveryLogRepository } = createService();

      mockFindSsgEvent(ssgEventRepository, { id: 36, eventBalance: 100_000 });
      refundLedgerRepository.findOne.mockResolvedValue(null);
      const seen = new Set<number>();
      mockRecoveryLogInsert(recoveryLogRepository, seen);

      await expect(service.refundForDeliveryFail(36, 4145, 10_000, 4145)).rejects.toThrow();
      expect(seen.size).toBe(0);
    });
  });

  describe('refundResendEventDeduction (재발송 선차감 역복원, 전용 멱등키)', () => {
    const input = { resendDeductionId: 'RDID-9', ssgEventId: 36, orderId: 4145, amount: 10_000 };

    it('최초 호출 → resend_deduction_id INSERT + 행사 잔액 += amount', async () => {
      const { service, ssgEventRepository, amountHistoryRepository, resendDeductRecoveryRepository } = createService();
      const event = { id: 36, eventBalance: 100_000 };
      mockFindSsgEvent(ssgEventRepository, event);
      const seen = new Set<string>();
      mockResendDeductInsert(resendDeductRecoveryRepository, seen);

      await service.refundResendEventDeduction(input);

      expect(seen.has('RDID-9')).toBe(true);
      expect(event.eventBalance).toBe(110_000);
      expect(amountHistoryRepository.save).toHaveBeenCalledTimes(1);
      expect(ssgEventRepository.save).toHaveBeenCalledTimes(1);
    });

    it('동일 resend_deduction_id 재호출 → ER_DUP_ENTRY 흡수, 잔액 미변경(멱등)', async () => {
      const { service, ssgEventRepository, amountHistoryRepository, resendDeductRecoveryRepository } = createService();
      const event = { id: 36, eventBalance: 100_000 };
      mockFindSsgEvent(ssgEventRepository, event);
      const seen = new Set<string>(['RDID-9']); // 이미 역복원됨
      mockResendDeductInsert(resendDeductRecoveryRepository, seen);

      await service.refundResendEventDeduction(input);

      expect(event.eventBalance).toBe(100_000);
      expect(amountHistoryRepository.save).not.toHaveBeenCalled();
      expect(ssgEventRepository.save).not.toHaveBeenCalled();
    });

    it('ssgEvent 없음 → throw (멱등키 미소비)', async () => {
      const { service, ssgEventRepository, resendDeductRecoveryRepository } = createService();
      mockFindSsgEvent(ssgEventRepository, null);
      const seen = new Set<string>();
      mockResendDeductInsert(resendDeductRecoveryRepository, seen);

      await expect(service.refundResendEventDeduction(input)).rejects.toThrow();
      expect(seen.size).toBe(0);
    });
  });
});
