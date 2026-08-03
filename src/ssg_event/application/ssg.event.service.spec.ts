jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, descriptor: PropertyDescriptor) => descriptor,
}));
import { BadRequestException } from '@nestjs/common';
import { SsgEventService } from './ssg.event.service';

describe('SsgEventService', () => {
  const createService = () => {
    const lockQueryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([{ acquired: 1 }]),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const ssgEventRepository = {
      manager: { connection: { createQueryRunner: () => lockQueryRunner } },
      insert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const amountHistoryRepository = {
      create: jest.fn((v) => v),
      save: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      count: jest.fn().mockResolvedValue(0),
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
      create: jest.fn((v) => v),
      save: jest.fn().mockResolvedValue(undefined),
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
      { assertLegacyAllowed: jest.fn().mockResolvedValue(undefined) } as any, // cutoverGuard (§9 컷오버 게이트)
    );

    return {
      service,
      lockQueryRunner,
      ssgEventRepository,
      amountHistoryRepository,
      recoveryLogRepository,
      resendDeductRecoveryRepository,
      resendDeductPendingRepository,
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
      await expect(service.create({ ...dto, eventPrice: 2_147_483_648 })).rejects.toBeInstanceOf(BadRequestException);

      expect(ssgEventRepository.insert).not.toHaveBeenCalled();
    });

    it('행사 순번이 정수/INT 범위를 벗어나면 거절한다', async () => {
      const { service, ssgEventRepository } = createService();

      // 0 은 기본값 1 로 치환되지 않고 거절돼야 한다(구 `order ? order : 1` 회귀 방지)
      await expect(service.create({ ...dto, order: 0 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.create({ ...dto, order: -1 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.create({ ...dto, order: 1.5 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.create({ ...dto, order: 2_147_483_648 })).rejects.toBeInstanceOf(BadRequestException);

      expect(ssgEventRepository.insert).not.toHaveBeenCalled();
    });

    it('쿠폰 유효기간이 정수/INT 범위를 벗어나면 거절한다', async () => {
      const { service, ssgEventRepository } = createService();

      await expect(service.create({ ...dto, couponExpiration: 0 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.create({ ...dto, couponExpiration: 1.5 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.create({ ...dto, couponExpiration: 2_147_483_648 })).rejects.toBeInstanceOf(
        BadRequestException,
      );

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

    it('이미 등록된 행사(행사키+행사코드+순번)면 거절하고 충전을 안내한다', async () => {
      const { service, ssgEventRepository } = createService();
      ssgEventRepository.findOne.mockResolvedValue({ id: 29, code: dto.code, no: dto.no, order: 1 });

      await expect(service.create(dto)).rejects.toThrow('잔액 충전');

      expect(ssgEventRepository.findOne).toHaveBeenCalledWith({
        where: { code: dto.code, no: dto.no, order: 1 },
      });
      expect(ssgEventRepository.insert).not.toHaveBeenCalled();
    });

    it('등록 락을 못 잡으면 등록하지 않고 커넥션을 반환한다', async () => {
      const { service, ssgEventRepository, lockQueryRunner } = createService();
      lockQueryRunner.query.mockResolvedValue([{ acquired: 0 }]);

      await expect(service.create(dto)).rejects.toBeInstanceOf(BadRequestException);

      expect(ssgEventRepository.findOne).not.toHaveBeenCalled();
      expect(ssgEventRepository.insert).not.toHaveBeenCalled();
      // 잡지 못한 락을 푸는 RELEASE_LOCK 은 나가면 안 되고, 커넥션은 반드시 반환돼야 한다
      expect(lockQueryRunner.query).toHaveBeenCalledTimes(1);
      expect(lockQueryRunner.query).not.toHaveBeenCalledWith('SELECT RELEASE_LOCK(?)', expect.anything());
      expect(lockQueryRunner.release).toHaveBeenCalledTimes(1);
    });

    it('등록 도중 실패해도 락을 풀고 커넥션을 반환한다', async () => {
      const { service, ssgEventRepository, lockQueryRunner } = createService();
      ssgEventRepository.insert.mockRejectedValue(new Error('insert 실패'));

      await expect(service.create(dto)).rejects.toThrow('insert 실패');

      expect(lockQueryRunner.query).toHaveBeenCalledWith('SELECT RELEASE_LOCK(?)', ['epopkon:ssg_event:register']);
      expect(lockQueryRunner.release).toHaveBeenCalledTimes(1);
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

  describe('selectAndDeductForReissueWithPending', () => {
    it('잠근 후보 중 잔액이 부족한 행사는 건너뛰고 다음 행사에 차감과 pending을 원자 기록한다', async () => {
      const { service, ssgEventRepository, amountHistoryRepository, resendDeductPendingRepository } = createService();
      const insufficient = { id: 10, eventBalance: 500 };
      const available = { id: 20, eventBalance: 20_000 };

      ssgEventRepository.createQueryBuilder.mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([insufficient, available]),
      });

      const result = await service.selectAndDeductForReissueWithPending({
        amount: 10_000,
        orderId: 4145,
        couponExpiration: 30,
        purpose: 'CS_REISSUE',
        issueOrderDeliveryId: null,
      });

      expect(result?.event).toBe(available);
      expect(insufficient.eventBalance).toBe(500);
      expect(available.eventBalance).toBe(10_000);
      expect(amountHistoryRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          ssgEventId: 20,
          amount: -10_000,
          balance: 10_000,
          orderId: 4145,
          isTemporary: false,
        }),
      );
      expect(resendDeductPendingRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          resendDeductionId: result?.resendDeductionId,
          ssgEventId: 20,
          orderId: 4145,
          amount: 10_000,
          purpose: 'CS_REISSUE',
          issueOrderDeliveryId: null,
        }),
      );
    });

    it('잠긴 후보가 모두 부족하면 차감/pending 없이 null을 반환한다', async () => {
      const { service, ssgEventRepository, amountHistoryRepository, resendDeductPendingRepository } = createService();
      ssgEventRepository.createQueryBuilder.mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([{ id: 10, eventBalance: 500 }]),
      });

      await expect(
        service.selectAndDeductForReissueWithPending({
          amount: 10_000,
          orderId: 4145,
          couponExpiration: 30,
          purpose: 'CS_REISSUE',
          issueOrderDeliveryId: null,
        }),
      ).resolves.toBeNull();
      expect(amountHistoryRepository.save).not.toHaveBeenCalled();
      expect(resendDeductPendingRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('restoreTemporaryEventBalance — 중복 복원 방지 검증', () => {
    const buildRestoreSut = (histories: any[], eventBalance = 1000) => {
      const { service, ssgEventRepository, amountHistoryRepository } = createService();

      amountHistoryRepository.find = jest.fn().mockResolvedValue(histories);
      amountHistoryRepository.update = jest.fn().mockResolvedValue({ affected: 1 });

      const event = { id: 10, eventBalance };
      mockFindSsgEvent(ssgEventRepository, event);

      return { service, amountHistoryRepository, ssgEventRepository, event };
    };

    it('복원 후 원본 이력을 isTemporary=false로 닫는다', async () => {
      const history = { id: 1, ssgEventId: 10, amount: -100, isTemporary: true, orderId: 1 };
      const { service, amountHistoryRepository } = buildRestoreSut([history]);

      await service.restoreTemporaryEventBalance(1);

      expect(amountHistoryRepository.update).toHaveBeenCalledWith({ id: 1 }, { isTemporary: false });
    });

    it('2회 연속 호출 시 1차 복원으로 닫힌 이력은 2차 호출 find 대상에서 제외된다', async () => {
      const history = { id: 1, ssgEventId: 10, amount: -100, isTemporary: true, orderId: 1 };
      const { service, amountHistoryRepository } = buildRestoreSut([history]);

      await service.restoreTemporaryEventBalance(1);

      // 2차 호출: isTemporary=true 이력 없음 (이미 닫혔으므로 DB에서 조회 안 됨)
      amountHistoryRepository.find = jest.fn().mockResolvedValue([]);
      const saveCalls = (amountHistoryRepository.save as jest.Mock).mock.calls.length;

      await service.restoreTemporaryEventBalance(1);

      // 2차 호출에서 save가 추가로 호출되지 않아야 함
      expect((amountHistoryRepository.save as jest.Mock).mock.calls.length).toBe(saveCalls);
    });

    it('amount >= 0인 이력은 복원 대상에서 제외된다', async () => {
      const histories = [
        { id: 1, ssgEventId: 10, amount: 100, isTemporary: true, orderId: 1 },
        { id: 2, ssgEventId: 10, amount: 0, isTemporary: true, orderId: 1 },
      ];
      const { service, amountHistoryRepository } = buildRestoreSut(histories);

      await service.restoreTemporaryEventBalance(1);

      expect(amountHistoryRepository.save).not.toHaveBeenCalled();
      expect(amountHistoryRepository.update).not.toHaveBeenCalled();
    });

    it('ssgEvent 없는 이력은 건너뛴다', async () => {
      const histories = [{ id: 1, ssgEventId: null, amount: -100, isTemporary: true, orderId: 1 }];
      const { service, amountHistoryRepository } = buildRestoreSut(histories);

      await service.restoreTemporaryEventBalance(1);

      expect(amountHistoryRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('restoreEventBalance — 주문 취소 SSG 이벤트 NET 복원', () => {
    const buildRestoreEventSut = (histories: any[], events: Record<number, any>) => {
      const { service, ssgEventRepository, amountHistoryRepository } = createService();

      amountHistoryRepository.find = jest.fn(({ where }: { where?: { ssgEventId?: number } } = {}) =>
        Promise.resolve(
          where?.ssgEventId == null
            ? histories
            : histories.filter((history) => history.ssgEventId === where.ssgEventId),
        ),
      );
      ssgEventRepository.createQueryBuilder.mockImplementation(() => {
        let id: number | undefined;
        const builder: any = {
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn((_clause: string, params: { id: number }) => {
            id = params.id;
            return builder;
          }),
          getOne: jest.fn(() => Promise.resolve(id ? (events[id] ?? null) : null)),
        };
        return builder;
      });

      return { service, amountHistoryRepository, ssgEventRepository, events };
    };

    it('단순 차감만 있는 주문은 행사별 차감액을 그대로 복원한다', async () => {
      const { service, amountHistoryRepository, events } = buildRestoreEventSut(
        [{ id: 1, ssgEventId: 10, amount: -100, isTemporary: false, orderId: 1 }],
        { 10: { id: 10, eventBalance: 900 } },
      );

      await service.restoreEventBalance(1);

      expect(events[10].eventBalance).toBe(1000);
      expect(amountHistoryRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ ssgEventId: 10, amount: 100, balance: 1000, orderId: 1, isTemporary: false }),
      );
    });

    it('이미 실패 환불로 복원되어 NET 0인 주문은 취소 복원을 추가하지 않는다', async () => {
      const { service, amountHistoryRepository, ssgEventRepository, events } = buildRestoreEventSut(
        [
          { id: 1, ssgEventId: 10, amount: -100, isTemporary: false, orderId: 1 },
          { id: 2, ssgEventId: 10, amount: 100, isTemporary: false, orderId: 1 },
        ],
        { 10: { id: 10, eventBalance: 1000 } },
      );

      await service.restoreEventBalance(1);

      expect(events[10].eventBalance).toBe(1000);
      expect(amountHistoryRepository.save).not.toHaveBeenCalled();
      expect(ssgEventRepository.save).not.toHaveBeenCalled();
    });

    it('실패 환불 후 재발송 재차감 이력이 섞이면 남은 NET 음수만 복원한다', async () => {
      const { service, amountHistoryRepository, events } = buildRestoreEventSut(
        [
          { id: 1, ssgEventId: 10, amount: -100, isTemporary: false, orderId: 1 },
          { id: 2, ssgEventId: 10, amount: 100, isTemporary: false, orderId: 1 },
          { id: 3, ssgEventId: 10, amount: -100, isTemporary: false, orderId: 1 },
        ],
        { 10: { id: 10, eventBalance: 900 } },
      );

      await service.restoreEventBalance(1);

      expect(events[10].eventBalance).toBe(1000);
      expect(amountHistoryRepository.save).toHaveBeenCalledTimes(1);
      expect(amountHistoryRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ ssgEventId: 10, amount: 100, balance: 1000 }),
      );
    });

    it('다중 행사 주문은 행사별 NET 기준으로 복원하고 NET 0 행사는 건너뛴다', async () => {
      const { service, amountHistoryRepository, events } = buildRestoreEventSut(
        [
          { id: 1, ssgEventId: 20, amount: -300, isTemporary: false, orderId: 1 },
          { id: 2, ssgEventId: 10, amount: -100, isTemporary: false, orderId: 1 },
          { id: 3, ssgEventId: 10, amount: 100, isTemporary: false, orderId: 1 },
        ],
        {
          10: { id: 10, eventBalance: 1000 },
          20: { id: 20, eventBalance: 700 },
        },
      );

      await service.restoreEventBalance(1);

      expect(events[10].eventBalance).toBe(1000);
      expect(events[20].eventBalance).toBe(1000);
      expect(amountHistoryRepository.save).toHaveBeenCalledTimes(1);
      expect(amountHistoryRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ ssgEventId: 20, amount: 300, balance: 1000 }),
      );
    });

    it('취소 복원 이력이 이미 쌓인 뒤 재호출되면 NET 0이라 no-op이다', async () => {
      const { service, amountHistoryRepository, ssgEventRepository, events } = buildRestoreEventSut(
        [
          { id: 1, ssgEventId: 10, amount: -100, isTemporary: false, orderId: 1 },
          { id: 2, ssgEventId: 10, amount: 100, isTemporary: false, orderId: 1 },
        ],
        { 10: { id: 10, eventBalance: 1000 } },
      );

      await service.restoreEventBalance(1);

      expect(events[10].eventBalance).toBe(1000);
      expect(amountHistoryRepository.save).not.toHaveBeenCalled();
      expect(ssgEventRepository.save).not.toHaveBeenCalled();
    });

    it('초기 조회 후 락 대기 중 다른 복원이 커밋되면 lock 이후 최신 NET 0을 보고 no-op이다', async () => {
      const { service, ssgEventRepository, amountHistoryRepository } = createService();
      const event = { id: 10, eventBalance: 1000 };
      const initialHistories = [{ id: 1, ssgEventId: 10, amount: -100, isTemporary: false, orderId: 1 }];
      const latestHistories = [
        { id: 1, ssgEventId: 10, amount: -100, isTemporary: false, orderId: 1 },
        { id: 2, ssgEventId: 10, amount: 100, isTemporary: false, orderId: 1 },
      ];
      amountHistoryRepository.find = jest
        .fn()
        .mockResolvedValueOnce(initialHistories)
        .mockResolvedValueOnce(latestHistories);
      mockFindSsgEvent(ssgEventRepository, event);

      await service.restoreEventBalance(1);

      expect(event.eventBalance).toBe(1000);
      expect(amountHistoryRepository.find).toHaveBeenCalledTimes(2);
      expect(amountHistoryRepository.save).not.toHaveBeenCalled();
      expect(ssgEventRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('lockEventsForCouponExpireChange — 피드백2/3 락 순서 통일 검증', () => {
    it('restore 대상 이벤트id + 후보 이벤트id를 id ASC 단일 쿼리로 선잠금한다', async () => {
      const { service, ssgEventRepository, amountHistoryRepository } = createService();

      // 기존(가차감중) 이벤트: id 7
      amountHistoryRepository.find = jest
        .fn()
        .mockResolvedValue([{ id: 1, ssgEventId: 7, amount: -100, isTemporary: true, orderId: 1 }]);

      // 후보(새 유효기간) 이벤트: id 3, id 9 (역순으로 반환되어도 정렬은 서비스가 강제)
      const lockQb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([{ id: 9 }, { id: 3 }]),
        setLock: jest.fn().mockReturnThis(),
      };
      ssgEventRepository.createQueryBuilder.mockReturnValue(lockQb);

      await service.lockEventsForCouponExpireChange(1, 60);

      // 마지막 호출(선잠금 쿼리)이 id ASC로 정렬되어 3개 id(7,3,9)를 IN 조건에 넣었는지 확인
      expect(lockQb.orderBy).toHaveBeenCalledWith('ssg.id', 'ASC');
      expect(lockQb.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(lockQb.where).toHaveBeenCalledWith('ssg.id IN (:...uniqueIds)', {
        uniqueIds: [3, 7, 9],
      });
    });

    it('대상 이벤트id가 없으면 잠금 쿼리를 실행하지 않는다', async () => {
      const { service, ssgEventRepository, amountHistoryRepository } = createService();
      amountHistoryRepository.find = jest.fn().mockResolvedValue([]);

      const lockQb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        setLock: jest.fn().mockReturnThis(),
      };
      ssgEventRepository.createQueryBuilder.mockReturnValue(lockQb);

      await service.lockEventsForCouponExpireChange(1, 60);

      expect(lockQb.setLock).not.toHaveBeenCalled();
    });
  });

  describe('hasOpenTempDeduction', () => {
    it('isTemporary=true, amount<0 이력이 있으면 true 반환', async () => {
      const { service, amountHistoryRepository } = createService();
      amountHistoryRepository.count = jest.fn().mockResolvedValue(1);

      const result = await service.hasOpenTempDeduction(1);

      expect(result).toBe(true);
      expect(amountHistoryRepository.count).toHaveBeenCalledWith({
        where: { orderId: 1, isTemporary: true, amount: expect.anything() },
      });
    });

    it('isTemporary=true, amount<0 이력이 없으면 false 반환', async () => {
      const { service, amountHistoryRepository } = createService();
      amountHistoryRepository.count = jest.fn().mockResolvedValue(0);

      const result = await service.hasOpenTempDeduction(1);

      expect(result).toBe(false);
    });
  });
});
