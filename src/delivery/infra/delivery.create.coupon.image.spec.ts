/**
 * 회귀: 쿠폰 이미지 파일명 무작위화 (감사 06-04 §7-4(2) / 06-06 즉시 트랙)
 *
 * 검증 목표 — 파일명이 예측 불가능(UUID 포함)하며, Date.now가 충돌해도 매 호출 고유해야 한다.
 * 과거 결함: `${now}-coupon.jpeg`(시각 순차) → public/ 무인증 정적 노출 하에서 열거(brute-force) 가능.
 *
 * 무거운 네이티브/네트워크 의존(canvas/sharp/axios/fs)은 목킹하고, 순수 파일명 계약만 검증한다.
 * 소비처(4 호출부)는 반환 path/fileName을 그대로 쓰므로(본문 §1-C), 이름 형식이 발송 흐름 계약의 핵심.
 */

// ─── 무거운 의존 목킹 ──────────────────────────────────────────────
jest.mock('canvas', () => {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    private _src: unknown = null;
    set src(v: unknown) {
      this._src = v;
      // 실제 canvas와 동일하게 src 할당 시 onload 발화 → createImageFromBuffer resolve
      queueMicrotask(() => this.onload && this.onload());
    }
    get src() {
      return this._src;
    }
  }
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    fillRect: jest.fn(),
    fillText: jest.fn(),
    beginPath: jest.fn(),
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    stroke: jest.fn(),
    drawImage: jest.fn(),
  };
  return {
    Image: FakeImage,
    createCanvas: jest.fn(() => ({
      width: 0,
      height: 0,
      getContext: jest.fn(() => ctx),
      toBuffer: jest.fn(() => Buffer.from('fake-jpeg')),
    })),
  };
});

jest.mock('jsbarcode', () => jest.fn());

jest.mock('sharp', () => {
  const chain: Record<string, jest.Mock> = {
    resize: jest.fn(() => chain),
    trim: jest.fn(() => chain),
    toBuffer: jest.fn(async () => Buffer.from('fake-img')),
    metadata: jest.fn(async () => ({ width: 100 })),
  };
  return jest.fn(() => chain);
});

jest.mock('fs/promises', () => ({
  writeFile: jest.fn(async () => undefined),
}));

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => ({ data: Buffer.from('img') })) },
}));

import * as fsPromises from 'fs/promises';
import { DeliveryCreateCouponImage } from './delivery.create.coupon.image';
import { IProductType } from '../../product/interface/product.type';

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function callGen(type: IProductType = IProductType.GENERAL) {
  return DeliveryCreateCouponImage(
    'https://example.com/product.png',
    '신세계 상품권 10000원',
    '8000000000001',
    '이마트',
    '2026. 12. 31',
    'https://example.com/top.png',
    'https://example.com/mid.png',
    type,
  );
}

describe('DeliveryCreateCouponImage 파일명 무작위화', () => {
  afterEach(() => jest.restoreAllMocks());

  it('파일명이 `<숫자>-<UUIDv4>-coupon.jpeg` 형식이다', async () => {
    const { fileName, path } = await callGen();
    expect(fileName).toMatch(new RegExp(`^\\d+-${UUID_RE}-coupon\\.jpeg$`, 'i'));
    expect(path.endsWith(`/public/${fileName}`)).toBe(true);
    expect(fsPromises.writeFile).toHaveBeenCalledWith(path, expect.anything());
  });

  it('과거 결함 형식(`<숫자>-coupon.jpeg`)이 아니다 — UUID 세그먼트 존재', async () => {
    const { fileName } = await callGen();
    expect(fileName).not.toMatch(/^\d+-coupon\.jpeg$/); // 시각 단독 = 예측가능(회귀 금지)
  });

  it('Date.now가 충돌해도(동일 ms) 매 호출 파일명이 고유하다', async () => {
    // 동일 배치 내 같은 밀리초여도 UUID로 충돌·추측 불가해야 함
    jest.spyOn(Date.prototype, 'getTime').mockReturnValue(1700000000000);
    const a = await callGen();
    const b = await callGen();
    expect(a.fileName).not.toBe(b.fileName);
    // 접두 now는 동일(정렬용 유지), 뒤 UUID만 달라야 함
    expect(a.fileName.startsWith('1700000000000-')).toBe(true);
    expect(b.fileName.startsWith('1700000000000-')).toBe(true);
  });

  it('SSG 타입(바코드 미생성 경로)도 동일한 무작위 형식이다', async () => {
    const { fileName } = await callGen(IProductType.SSG);
    expect(fileName).toMatch(new RegExp(`^\\d+-${UUID_RE}-coupon\\.jpeg$`, 'i'));
  });
});
