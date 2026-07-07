import { BadRequestException } from '@nestjs/common';
import { IOrderType } from '../interface/order.type';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import {
  validateSsgUniformSend,
  validateDeliverySendTypes,
  resolveProductDuplicateLimit,
  assertWalletOnlyParamsAbsent,
  assertSettleListDeliveryCoverage,
} from './order.validation';
import { WalletCutoverMode } from '../../wallet/config/wallet-cutover.config';

describe('validateSsgUniformSend', () => {
  const t = '2026-06-15T10:00:00';

  it('SSG가 아니면 검증을 건너뛴다', () => {
    expect(() =>
      validateSsgUniformSend(IOrderType.GENERAL, [
        { sendType: 'IMMEDIATE' },
        { sendType: 'RESERVE', sendRequestAt: t },
      ]),
    ).not.toThrow();
  });

  it('SSG 전체 즉시발송이면 통과한다', () => {
    expect(() =>
      validateSsgUniformSend(IOrderType.SSG, [{ sendType: 'IMMEDIATE' }, { sendType: 'IMMEDIATE' }]),
    ).not.toThrow();
  });

  it('SSG 전체 예약이고 예약시각이 동일하면 통과한다', () => {
    expect(() =>
      validateSsgUniformSend(IOrderType.SSG, [
        { sendType: 'RESERVE', sendRequestAt: t },
        { sendType: 'RESERVE', sendRequestAt: t },
      ]),
    ).not.toThrow();
  });

  it('SSG 즉시/예약 혼합이면 400을 던진다', () => {
    expect(() =>
      validateSsgUniformSend(IOrderType.SSG, [{ sendType: 'IMMEDIATE' }, { sendType: 'RESERVE', sendRequestAt: t }]),
    ).toThrow(BadRequestException);
  });

  it('SSG 예약시각이 서로 달라도 허용한다 (상품별 예약시각)', () => {
    expect(() =>
      validateSsgUniformSend(IOrderType.SSG, [
        { sendType: 'RESERVE', sendRequestAt: '2026-06-15T10:00:00' },
        { sendType: 'RESERVE', sendRequestAt: '2026-06-15T11:00:00' },
      ]),
    ).not.toThrow();
  });

  it('저장 단계의 sendType 미선택(draft) 행은 무시한다', () => {
    expect(() => validateSsgUniformSend(IOrderType.SSG, [{ sendType: null }, { sendType: null }])).not.toThrow();
  });
});

describe('validateDeliverySendTypes', () => {
  const t = '2026-06-15T10:00:00';

  it('모든 행이 유효한 sendType이면 통과한다', () => {
    expect(() =>
      validateDeliverySendTypes([{ sendType: 'IMMEDIATE' }, { sendType: 'RESERVE', sendRequestAt: t }]),
    ).not.toThrow();
  });

  it('sendType이 null인 행이 있으면 400을 던진다 (발송요청 직전 차단)', () => {
    expect(() => validateDeliverySendTypes([{ sendType: 'IMMEDIATE' }, { sendType: null }])).toThrow(
      BadRequestException,
    );
  });

  it('RESERVE 행에 sendRequestAt이 없으면 400을 던진다', () => {
    expect(() => validateDeliverySendTypes([{ sendType: 'RESERVE', sendRequestAt: null }])).toThrow(
      BadRequestException,
    );
  });
});

describe('resolveProductDuplicateLimit', () => {
  it('일반(할인/할증 없음) mapping은 duplicatePhoneLimit을 제한으로 가진다', () => {
    const adjustments = new Map<number, IPriceAdjustment | null>([[1, null]]);
    const limit = resolveProductDuplicateLimit([{ id: 1, productId: 101 }], adjustments, 2);
    expect(limit.get(101)).toBe(2);
  });

  it('같은 productId에 유한 제한 mapping이 하나라도 있으면 그 productId는 제한 대상이다 (무제한 mapping 배송건 합산 위함)', () => {
    // mapping1 = 할증(무제한), mapping2 = 일반(유한) — 둘 다 productId 101
    const adjustments = new Map<number, IPriceAdjustment | null>([
      [1, IPriceAdjustment.ADDITIONAL],
      [2, null],
    ]);
    const limit = resolveProductDuplicateLimit(
      [
        { id: 1, productId: 101 },
        { id: 2, productId: 101 },
      ],
      adjustments,
      3,
    );
    expect(limit.get(101)).toBe(3);
  });

  it('같은 productId의 모든 mapping이 무제한(할증)이면 검사에서 제외된다', () => {
    const adjustments = new Map<number, IPriceAdjustment | null>([
      [1, IPriceAdjustment.ADDITIONAL],
      [2, IPriceAdjustment.ADDITIONAL],
    ]);
    const limit = resolveProductDuplicateLimit(
      [
        { id: 1, productId: 101 },
        { id: 2, productId: 101 },
      ],
      adjustments,
      3,
    );
    expect(limit.has(101)).toBe(false);
  });

  it('duplicatePhoneLimit=0(무제한)이면 모든 productId가 제외된다', () => {
    const adjustments = new Map<number, IPriceAdjustment | null>([[1, null]]);
    const limit = resolveProductDuplicateLimit([{ id: 1, productId: 101 }], adjustments, 0);
    expect(limit.has(101)).toBe(false);
  });

  it('서로 다른 productId는 각각 제한을 가진다', () => {
    const adjustments = new Map<number, IPriceAdjustment | null>([
      [1, null],
      [2, null],
    ]);
    const limit = resolveProductDuplicateLimit(
      [
        { id: 1, productId: 101 },
        { id: 2, productId: 202 },
      ],
      adjustments,
      1,
    );
    expect(limit.get(101)).toBe(1);
    expect(limit.get(202)).toBe(1);
  });
});

describe('assertWalletOnlyParamsAbsent', () => {
  it('LEGACY 모드에서 depositUseAmount 전송 시 400', () => {
    expect(() => assertWalletOnlyParamsAbsent(WalletCutoverMode.LEGACY, { depositUseAmount: 10000 })).toThrow(
      BadRequestException,
    );
  });

  it('SHADOW 모드에서 pointUseAmount 전송 시 400', () => {
    expect(() => assertWalletOnlyParamsAbsent(WalletCutoverMode.SHADOW, { pointUseAmount: 500 })).toThrow(
      BadRequestException,
    );
  });

  it('LEGACY 모드에서 depositUseEnabled=false 라도 명시 전송이면 400', () => {
    expect(() => assertWalletOnlyParamsAbsent(WalletCutoverMode.LEGACY, { depositUseEnabled: false })).toThrow(
      BadRequestException,
    );
  });

  it('WALLET 모드에서는 전부 허용', () => {
    expect(() =>
      assertWalletOnlyParamsAbsent(WalletCutoverMode.WALLET, {
        pointUseAmount: 500,
        depositUseAmount: 10000,
        depositUseEnabled: true,
      }),
    ).not.toThrow();
  });

  it('LEGACY 모드라도 파라미터 미전송이면 허용', () => {
    expect(() => assertWalletOnlyParamsAbsent(WalletCutoverMode.LEGACY, {})).not.toThrow();
  });
});

describe('assertSettleListDeliveryCoverage', () => {
  const orderProducts = [
    { id: 10, orderDeliveries: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    { id: 11, orderDeliveries: [{ id: 4 }, { id: 5 }] },
  ];

  it('행 간 중복 deliveryId 는 400', () => {
    expect(() =>
      assertSettleListDeliveryCoverage(
        [
          { id: 10, deliveryIds: [1, 2] },
          { id: 10, deliveryIds: [2, 3] },
        ],
        orderProducts,
        { requireFullCoverage: false },
      ),
    ).toThrow('정산 입력에 중복된 발송 내역이 있습니다.');
  });

  it('create: 전 행 delivery-scoped 인데 전량 미커버면 400', () => {
    expect(() =>
      assertSettleListDeliveryCoverage(
        [
          { id: 10, deliveryIds: [1, 2, 3] },
          { id: 11, deliveryIds: [4] }, // 5 누락
        ],
        orderProducts,
        { requireFullCoverage: true },
      ),
    ).toThrow(BadRequestException);
  });

  it('create: 전량 커버면 통과', () => {
    expect(() =>
      assertSettleListDeliveryCoverage(
        [
          { id: 10, deliveryIds: [1, 2, 3] },
          { id: 11, deliveryIds: [4, 5] },
        ],
        orderProducts,
        { requireFullCoverage: true },
      ),
    ).not.toThrow();
  });

  it('create: mapping-level 행 혼재 시 커버리지 검사 skip (중복 검사만)', () => {
    expect(() =>
      assertSettleListDeliveryCoverage([{ id: 10, deliveryIds: [1, 2] }, { id: 11 }], orderProducts, {
        requireFullCoverage: true,
      }),
    ).not.toThrow();
  });

  it('update(requireFullCoverage=false): 부분 제출 허용', () => {
    expect(() =>
      assertSettleListDeliveryCoverage([{ id: 10, deliveryIds: [1] }], orderProducts, {
        requireFullCoverage: false,
      }),
    ).not.toThrow();
  });
});
