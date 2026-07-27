import { BadRequestException } from '@nestjs/common';
import { Brackets } from 'typeorm';
import { SettleService } from './settle.service';

const mockExcelRowCommit = jest.fn();
const mockExcelAddRow = jest.fn().mockReturnValue({ commit: mockExcelRowCommit });
const mockExcelSheetCommit = jest.fn().mockResolvedValue(undefined);
const mockExcelWorkbookCommit = jest.fn().mockResolvedValue(undefined);

jest.mock('exceljs', () => ({
  stream: {
    xlsx: {
      WorkbookWriter: jest.fn().mockImplementation(() => ({
        addWorksheet: jest.fn().mockReturnValue({
          columns: [],
          addRow: mockExcelAddRow,
          commit: mockExcelSheetCommit,
        }),
        commit: mockExcelWorkbookCommit,
      })),
    },
  },
}));

jest.mock('../../util/file.util', () => ({
  createExportTempPath: jest.fn().mockReturnValue('partner-settle-test.xlsx'),
}));

jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: any, _key: string, descriptor: PropertyDescriptor) => descriptor,
  Propagation: { REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSource: jest.fn(),
}));

function makeService(overrides: Record<string, any> = {}): any {
  const svc = Object.create(SettleService.prototype);
  Object.assign(svc, {
    orderRepository: { createQueryBuilder: jest.fn(), manager: {} },
    userRepository: { findOne: jest.fn(), createQueryBuilder: jest.fn() },
    orderDeliveryRepository: { find: jest.fn().mockResolvedValue([]) },
    activityLogService: { verifyPassword: jest.fn().mockResolvedValue(undefined), createLog: jest.fn() },
    cryptoCipher: { safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01012345678') },
    walletManagedPredicate: { isWalletManaged: jest.fn().mockResolvedValue(false) },
    settleConfirmationWalletService: { confirmSettlement: jest.fn() },
    legacyWalletCreditSyncService: { syncCredit: jest.fn() },
    ...overrides,
  });
  return svc;
}

// ────────────────────────────────────────────────────────────────────────────
// #54 fix: 협력사 정산 스냅샷 검증
// ────────────────────────────────────────────────────────────────────────────

function makeSelectQb(overrides: Record<string, any> = {}): any {
  return {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(0),
    getMany: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeExcelQb(overrides: Record<string, any> = {}): any {
  return {
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    whereInIds: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    getMany: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeOrderDelivery(
  partnerSettleFee: number | null,
  partnerSettlePriceAdjustment: string | null,
  snapshotPrice = 1000,
  overrides: Record<string, any> = {},
) {
  return {
    id: 1,
    sendRequestAt: new Date('2026-06-19T09:00:00+09:00'),
    actualSendAt: new Date('2026-06-20T10:30:00+09:00'),
    failedAt: null,
    couponStatus: 'USED',
    orderProductMapping: {
      snapshotProductPrice: snapshotPrice,
      partnerSettleFee,
      partnerSettlePriceAdjustment,
      order: {
        id: 42,
        eventName: 'test',
        code: 'ORD-42',
        user: { company: { businessName: '고객사' } },
        clientUser: null,
      },
      product: {
        name: '상품',
        price: 1500,
        category: 'MOBILE_COUPON',
        classificationId: null,
        brand: null,
        partnerCompany: {
          businessName: '협력사',
          settleMethod: 'MONTHLY',
          userDiscounts: [
            { category: null, classificationId: null, brand: null, pricePercent: 20, priceAdjustment: 'DISCOUNT' },
          ],
        },
      },
    },
    ...overrides,
  };
}

function makeExcelOrderDelivery(id: number, actualSendAt: string | null, overrides: Record<string, any> = {}) {
  return {
    id,
    actualSendAt: actualSendAt ? new Date(actualSendAt) : null,
    failedAt: null,
    tradeAt: null,
    discardedAt: null,
    expireAt: new Date('2026-07-20T23:59:59+09:00'),
    deliveryTarget: 'encrypted-phone',
    couponStatus: 'USED',
    barCode: `BAR-${id}`,
    transactionId: `TR-${id}`,
    galaxiaBalance: 0,
    choiceSelectProduct: null,
    orderProductMapping: {
      snapshotProductPrice: 1000,
      fromPhoneNumber: '0212345678',
      sendTitle: '발송명',
      order: {
        id: 42,
        eventName: '이벤트',
        code: 'ORD-42',
        user: { company: { businessName: '고객사' } },
        clientUser: null,
      },
      product: {
        code: `EP-${id}`,
        name: `상품-${id}`,
        price: 1500,
        expireDay: 30,
        brand: { nameKorean: '브랜드' },
        partnerCompany: {
          businessName: id === 101 ? '갤럭시아' : '일반협력사',
          settleMethod: 'CARD',
          validityStartsNextDay: false,
        },
      },
    },
    ...overrides,
  };
}

function expectNoGalaxiaPartnerFilter(qb: { andWhere: jest.Mock }) {
  const allArgs = qb.andWhere.mock.calls.flat();
  expect(allArgs.some((arg: unknown) => arg instanceof Brackets)).toBe(false);
  expect(JSON.stringify(allArgs)).not.toContain('galaxiaType');
  expect(JSON.stringify(allArgs)).not.toContain('partnerCompany.type');
}

describe('SettleService — getPartnerCompanyList (#54 fix)', () => {
  beforeEach(() => {
    mockExcelAddRow.mockClear();
    mockExcelRowCommit.mockClear();
    mockExcelSheetCommit.mockClear();
    mockExcelWorkbookCommit.mockClear();
  });

  it('검색 기간은 주문 등록일이 아니라 실제 발송일 기준으로 적용하고 갤럭시아도 제외하지 않는다', async () => {
    const qb = makeSelectQb({
      getCount: jest.fn().mockResolvedValue(1),
      getMany: jest.fn().mockResolvedValue([makeOrderDelivery(10, 'DISCOUNT', 1000)]),
    });
    const svc = makeService({ orderDeliveryRepository: { createQueryBuilder: jest.fn().mockReturnValue(qb) } });

    const result = await svc.getPartnerCompanyList({
      startAt: '2026-06-20T00:00:00',
      endAt: '2026-06-20T23:59:59',
      page: 1,
      take: 10,
    });

    expect(qb.andWhere).toHaveBeenCalledWith('orderDelivery.actualSendAt IS NOT NULL');
    expect(qb.andWhere).toHaveBeenCalledWith('orderDelivery.actualSendAt >= :actualSendAtStartAt', {
      actualSendAtStartAt: '2026-06-20 00:00:00',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('orderDelivery.actualSendAt <= :actualSendAtEndAt', {
      actualSendAtEndAt: '2026-06-20 23:59:59',
    });
    expect(qb.orderBy).toHaveBeenCalledWith('orderDelivery.actualSendAt', 'DESC');
    expect(qb.addOrderBy).toHaveBeenCalledWith('orderDelivery.id', 'DESC');
    expectNoGalaxiaPartnerFilter(qb);
    expect(result.list[0].id).toBe(1);
    expect(result.list[0].registeredAt).toBe('2026-06-20T10:30:00');
  });

  it('스냅샷 컬럼이 있으면 현재 상품가/할인조건 무시하고 스냅샷 기준으로 계산한다', async () => {
    const qb = makeSelectQb({
      getCount: jest.fn().mockResolvedValue(1),
      getMany: jest.fn().mockResolvedValue([makeOrderDelivery(10, 'DISCOUNT', 1000)]),
    });
    const svc = makeService({ orderDeliveryRepository: { createQueryBuilder: jest.fn().mockReturnValue(qb) } });

    const result = await svc.getPartnerCompanyList({
      startAt: '2026-06-01T00:00:00',
      endAt: '2026-06-30T23:59:59',
      page: 1,
      take: 10,
    });

    // snapshotPrice=1000, fee=10(스냅샷) → settlePrice=900. 현재 product.price=1500 or partnerDiscount=20% 미사용.
    expect(result.list[0]).toMatchObject({ deliveryPrice: 1000, fee: 10, feePrice: 100, settlePrice: 900 });
    expect(result.list[0]).not.toMatchObject({ deliveryPrice: 1500 });
    expect(result.list[0]).not.toMatchObject({ fee: 20 });
  });

  it('협력사 할인 조건이 변경되어도 저장된 스냅샷(fee=5)으로 계산한다', async () => {
    const qb = makeSelectQb({
      getCount: jest.fn().mockResolvedValue(1),
      getMany: jest.fn().mockResolvedValue([makeOrderDelivery(5, 'DISCOUNT', 1000)]),
    });
    const svc = makeService({ orderDeliveryRepository: { createQueryBuilder: jest.fn().mockReturnValue(qb) } });

    const result = await svc.getPartnerCompanyList({
      startAt: '2026-06-01T00:00:00',
      endAt: '2026-06-30T23:59:59',
      page: 1,
      take: 10,
    });

    expect(result.list[0]).toMatchObject({ fee: 5, feePrice: 50, settlePrice: 950 });
    expect(result.list[0]).not.toMatchObject({ fee: 20, feePrice: 200, settlePrice: 800 });
  });

  it('스냅샷 없는 legacy row는 현재 할인조건 재매칭 없이 fee=0으로 처리한다', async () => {
    const qb = makeSelectQb({
      getCount: jest.fn().mockResolvedValue(1),
      getMany: jest.fn().mockResolvedValue([makeOrderDelivery(null, null, 1000)]),
    });
    const svc = makeService({ orderDeliveryRepository: { createQueryBuilder: jest.fn().mockReturnValue(qb) } });

    const result = await svc.getPartnerCompanyList({
      startAt: '2026-06-01T00:00:00',
      endAt: '2026-06-30T23:59:59',
      page: 1,
      take: 10,
    });

    // userDiscounts에 20% 있어도 재매칭 금지 → fee=0
    expect(result.list[0]).toMatchObject({ fee: 0, feePrice: 0, settlePrice: 1000 });
    expect(result.list[0]).not.toMatchObject({ fee: 20 });
  });

  it('스냅샷 fee=0/priceAdjustment=null(할인없음)은 현재 할인조건으로 소급하지 않는다', async () => {
    const qb = makeSelectQb({
      getCount: jest.fn().mockResolvedValue(1),
      getMany: jest.fn().mockResolvedValue([makeOrderDelivery(0, null, 1000)]),
    });
    const svc = makeService({ orderDeliveryRepository: { createQueryBuilder: jest.fn().mockReturnValue(qb) } });

    const result = await svc.getPartnerCompanyList({
      startAt: '2026-06-01T00:00:00',
      endAt: '2026-06-30T23:59:59',
      page: 1,
      take: 10,
    });

    expect(result.list[0]).toMatchObject({ fee: 0, feePrice: 0, settlePrice: 1000 });
    expect(result.list[0]).not.toMatchObject({ fee: 20 });
  });

  it('엑셀 다운로드도 발송내역 id와 실제 발송일 기준으로 필터링하고 갤럭시아를 제외하지 않는다', async () => {
    const idQb = makeExcelQb({
      getRawMany: jest.fn().mockResolvedValue([{ id: 101 }, { id: 202 }]),
    });
    const graphQb = makeExcelQb({
      getMany: jest
        .fn()
        .mockResolvedValue([
          makeExcelOrderDelivery(101, '2026-06-20T10:30:00+09:00'),
          makeExcelOrderDelivery(202, '2026-06-20T11:30:00+09:00'),
        ]),
    });
    const orderDeliveryRepository = {
      createQueryBuilder: jest.fn().mockReturnValueOnce(idQb).mockReturnValueOnce(graphQb),
    };
    const activityLogService = { verifyPassword: jest.fn().mockResolvedValue(undefined), createLog: jest.fn() };
    const svc = makeService({ orderDeliveryRepository, activityLogService });

    const result = await svc.partnerCompanyExcelDownload(
      { id: 7, email: 'admin@example.com' },
      {
        password: 'pw',
        startAt: '2026-06-20T00:00:00',
        endAt: '2026-06-20T23:59:59',
        downloadReason: '검증',
      },
    );

    expect(idQb.select).toHaveBeenCalledWith('orderDelivery.id', 'id');
    expect(idQb.orderBy).toHaveBeenCalledWith('orderDelivery.actualSendAt', 'DESC');
    expect(idQb.addOrderBy).toHaveBeenCalledWith('orderDelivery.id', 'DESC');
    expect(idQb.andWhere).toHaveBeenCalledWith('orderDelivery.actualSendAt IS NOT NULL');
    expect(idQb.andWhere).toHaveBeenCalledWith('orderDelivery.actualSendAt >= :actualSendAtStartAt', {
      actualSendAtStartAt: '2026-06-20 00:00:00',
    });
    expect(idQb.andWhere).toHaveBeenCalledWith('orderDelivery.actualSendAt <= :actualSendAtEndAt', {
      actualSendAtEndAt: '2026-06-20 23:59:59',
    });
    expectNoGalaxiaPartnerFilter(idQb);
    expect(graphQb.whereInIds).toHaveBeenCalledWith([101, 202]);
    expect(mockExcelAddRow).toHaveBeenCalledTimes(2);
    expect(mockExcelAddRow).toHaveBeenCalledWith(expect.objectContaining({ partnerCompanyName: '갤럭시아' }));
    expect(mockExcelSheetCommit).toHaveBeenCalled();
    expect(mockExcelWorkbookCommit).toHaveBeenCalled();
    expect(activityLogService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        requestUrl: '/settle/partner-company/excel-download',
        recordCount: 2,
        requestParams: expect.objectContaining({
          startAt: '2026-06-20T00:00:00',
          endAt: '2026-06-20T23:59:59',
        }),
      }),
    );
    expect(result.filePath).toBe('partner-settle-test.xlsx');
  });
});

describe('SettleService — confirmSingleOrderTx (#20 fix)', () => {
  const ORDER_ID = 42;

  function makeOrderQb(order: object | null) {
    const qb: any = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(order),
    };
    return qb;
  }

  function makeAtomicUpdateQb(affected = 1) {
    return {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected }),
    } as any;
  }

  function makeUserCqb() {
    return {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    } as any;
  }

  it('lock 후 getOrderSettlementSummary 를 재호출하며 fresh netAmount 를 settledAmountSnapshot 에 저장한다', async () => {
    const order = { id: ORDER_ID, settleStatus: null, clientUserId: null, userId: 7, isSettleBalance: false };
    const atomicQb = makeAtomicUpdateQb(1);

    const svc = makeService({
      orderRepository: {
        createQueryBuilder: jest.fn().mockReturnValueOnce(makeOrderQb(order)).mockReturnValueOnce(atomicQb),
        manager: {},
      },
      userRepository: {
        findOne: jest.fn().mockResolvedValue({ id: 7 }),
        createQueryBuilder: jest.fn().mockReturnValue(makeUserCqb()),
      },
    });

    const summarySpy = jest
      .spyOn(svc, 'getOrderSettlementSummary')
      .mockResolvedValue(new Map([[ORDER_ID, { netAmount: 7_000, hasPending: false }]]));

    // stale 10000 전달 — fix 없으면 이 값이 snapshot 에 저장됨
    await (svc as any).confirmSingleOrderTx(ORDER_ID, { netAmount: 10_000, hasPending: false });

    expect(summarySpy).toHaveBeenCalledTimes(1);
    expect(summarySpy).toHaveBeenCalledWith([ORDER_ID]);
    expect(atomicQb.set).toHaveBeenCalledWith(expect.objectContaining({ settledAmountSnapshot: 7_000 }));
    expect(atomicQb.set).not.toHaveBeenCalledWith(expect.objectContaining({ settledAmountSnapshot: 10_000 }));
  });

  it('allSettleAmount 차감에도 stale(10000) 아닌 fresh(7000) 가 전달된다', async () => {
    const order = { id: ORDER_ID, settleStatus: null, clientUserId: null, userId: 7, isSettleBalance: false };
    const atomicQb = makeAtomicUpdateQb(1);
    const userCqb = makeUserCqb();

    const svc = makeService({
      orderRepository: {
        createQueryBuilder: jest.fn().mockReturnValueOnce(makeOrderQb(order)).mockReturnValueOnce(atomicQb),
        manager: {},
      },
      userRepository: {
        findOne: jest.fn().mockResolvedValue({ id: 7 }),
        createQueryBuilder: jest.fn().mockReturnValue(userCqb),
      },
    });

    jest
      .spyOn(svc, 'getOrderSettlementSummary')
      .mockResolvedValue(new Map([[ORDER_ID, { netAmount: 7_000, hasPending: false }]]));

    await (svc as any).confirmSingleOrderTx(ORDER_ID, { netAmount: 10_000, hasPending: false });

    expect(userCqb.setParameters).toHaveBeenCalledWith({ amount: 7_000 });
    expect(userCqb.setParameters).not.toHaveBeenCalledWith({ amount: 10_000 });
    // 레거시 정산확정 → wallet credit_used SETTLE_RELEASE(-fresh netAmount) 동기화
    expect((svc as any).legacyWalletCreditSyncService.syncCredit).toHaveBeenCalledWith(
      (svc as any).orderRepository.manager,
      expect.objectContaining({ billingUserId: 7, orderId: ORDER_ID, delta: -7_000, type: 'SETTLE_RELEASE' }),
    );
  });

  it('레거시 정산해제(PRE_PAYMENT)는 wallet credit_used 를 SETTLE_UNDO(+snapshot) 로 동기화한다', async () => {
    const order = {
      id: ORDER_ID,
      settleStatus: 'SETTLE_COMPLETE',
      clientUserId: null,
      userId: 7,
      isSettleBalance: false,
      isSettleComplete: true,
      settledAmountSnapshot: 7_000,
    };
    const lockQb = makeOrderQb(order);
    const updateQb = makeAtomicUpdateQb(1);
    const svc = makeService({
      orderRepository: {
        createQueryBuilder: jest.fn().mockReturnValueOnce(lockQb).mockReturnValueOnce(updateQb),
        manager: { __undo: true },
      },
      userRepository: {
        findOne: jest.fn().mockResolvedValue({ id: 7, settleCondition: 'PRE_PAYMENT' }),
        createQueryBuilder: jest.fn().mockReturnValue(makeUserCqb()),
      },
    });
    jest.spyOn(svc, 'getSettledDiscardRestoreAmount').mockResolvedValue(0);

    await (svc as any).updateUserPerOrder({ orderId: ORDER_ID, settleStatus: 'UNSETTLE_NORMAL' });

    expect((svc as any).legacyWalletCreditSyncService.syncCredit).toHaveBeenCalledWith(
      (svc as any).orderRepository.manager,
      expect.objectContaining({ billingUserId: 7, orderId: ORDER_ID, delta: 7_000, type: 'SETTLE_UNDO' }),
    );
  });

  it('hasPending=true 이면 재계산 없이 400 을 던진다', async () => {
    const order = { id: ORDER_ID, settleStatus: null, clientUserId: null, userId: 7, isSettleBalance: false };

    const svc = makeService({
      orderRepository: {
        createQueryBuilder: jest.fn().mockReturnValue(makeOrderQb(order)),
        manager: {},
      },
      userRepository: { findOne: jest.fn().mockResolvedValue({ id: 7 }) },
    });

    const summarySpy = jest.spyOn(svc, 'getOrderSettlementSummary');

    await expect(
      (svc as any).confirmSingleOrderTx(ORDER_ID, { netAmount: 5_000, hasPending: true }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // hasPending 차단은 재계산 전 — spy 호출 없어야 함
    expect(summarySpy).not.toHaveBeenCalled();
  });

  it('SETTLE_COMPLETE 주문은 재계산 없이 skipped 를 반환한다', async () => {
    const order = { id: ORDER_ID, settleStatus: 'SETTLE_COMPLETE', clientUserId: null, userId: 7 };

    const svc = makeService({
      orderRepository: {
        createQueryBuilder: jest.fn().mockReturnValue(makeOrderQb(order)),
        manager: {},
      },
    });

    const summarySpy = jest.spyOn(svc, 'getOrderSettlementSummary');

    const result = await (svc as any).confirmSingleOrderTx(ORDER_ID, { netAmount: 5_000, hasPending: false });

    expect(result).toBe('skipped');
    expect(summarySpy).not.toHaveBeenCalled();
  });

  it('프리로드 시점 hasPending=false 였어도 lock 후 재계산에서 hasPending=true 면 400 을 던진다', async () => {
    const order = { id: ORDER_ID, settleStatus: null, clientUserId: null, userId: 7, isSettleBalance: false };

    const svc = makeService({
      orderRepository: {
        createQueryBuilder: jest.fn().mockReturnValue(makeOrderQb(order)),
        manager: {},
      },
      userRepository: {
        findOne: jest.fn().mockResolvedValue({ id: 7 }),
        createQueryBuilder: jest.fn(),
      },
    });

    jest
      .spyOn(svc, 'getOrderSettlementSummary')
      .mockResolvedValue(new Map([[ORDER_ID, { netAmount: 5_000, hasPending: true }]]));

    await expect(
      (svc as any).confirmSingleOrderTx(ORDER_ID, { netAmount: 5_000, hasPending: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
