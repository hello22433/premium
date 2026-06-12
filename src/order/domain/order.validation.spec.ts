import { BadRequestException } from '@nestjs/common';
import { IOrderType } from '../interface/order.type';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import {
  validateSsgUniformSend,
  validateDeliverySendTypes,
  resolveProductDuplicateLimit,
} from './order.validation';

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
      validateSsgUniformSend(IOrderType.SSG, [
        { sendType: 'IMMEDIATE' },
        { sendType: 'RESERVE', sendRequestAt: t },
      ]),
    ).toThrow(BadRequestException);
  });

  it('SSG 예약시각이 서로 다르면 400을 던진다', () => {
    expect(() =>
      validateSsgUniformSend(IOrderType.SSG, [
        { sendType: 'RESERVE', sendRequestAt: '2026-06-15T10:00:00' },
        { sendType: 'RESERVE', sendRequestAt: '2026-06-15T11:00:00' },
      ]),
    ).toThrow(BadRequestException);
  });

  it('저장 단계의 sendType 미선택(draft) 행은 무시한다', () => {
    expect(() =>
      validateSsgUniformSend(IOrderType.SSG, [{ sendType: null }, { sendType: null }]),
    ).not.toThrow();
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
    expect(() =>
      validateDeliverySendTypes([{ sendType: 'IMMEDIATE' }, { sendType: null }]),
    ).toThrow(BadRequestException);
  });

  it('RESERVE 행에 sendRequestAt이 없으면 400을 던진다', () => {
    expect(() =>
      validateDeliverySendTypes([{ sendType: 'RESERVE', sendRequestAt: null }]),
    ).toThrow(BadRequestException);
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
