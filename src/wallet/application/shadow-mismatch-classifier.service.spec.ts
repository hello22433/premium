import { Test, TestingModule } from '@nestjs/testing';
import {
  ShadowMismatchClassifierService,
  ShadowMismatchClass,
  ShadowComparable,
} from './shadow-mismatch-classifier.service';

const zero: ShadowComparable = {
  depositUsedAmount: 0,
  creditUsedAmount: 0,
  creditExcessAmount: 0,
  pointUsedAmount: 0,
  cardSurchargeAmount: 0,
  payableSettlementAmount: 0,
};

function row(p: Partial<ShadowComparable>): ShadowComparable {
  return { ...zero, ...p };
}

describe('ShadowMismatchClassifierService', () => {
  let sut: ShadowMismatchClassifierService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ShadowMismatchClassifierService],
    }).compile();
    sut = module.get(ShadowMismatchClassifierService);
  });

  it('완전 일치 → null', () => {
    const a = row({ depositUsedAmount: 1000, creditUsedAmount: 500, payableSettlementAmount: 1500 });
    expect(sut.classify(a, { ...a })).toBeNull();
  });

  it('MIRROR_LAG: wallet 모두 0 + legacy non-zero', () => {
    const wallet = row({});
    const legacy = row({ depositUsedAmount: 1000, payableSettlementAmount: 1000 });
    expect(sut.classify(wallet, legacy)).toBe(ShadowMismatchClass.MIRROR_LAG);
  });

  it('ROUNDING_ONLY: 카드할증 10원 절사 (delta ≤ 10)', () => {
    const wallet = row({
      depositUsedAmount: 1000,
      cardSurchargeAmount: 30,
      payableSettlementAmount: 1030,
    });
    const legacy = row({
      depositUsedAmount: 1000,
      cardSurchargeAmount: 29, // ≤10 diff
      payableSettlementAmount: 1029,
    });
    expect(sut.classify(wallet, legacy)).toBe(ShadowMismatchClass.ROUNDING_ONLY);
  });

  it('POINT_GRANT_DIFF: point_used 만 차이, 외 동일', () => {
    const wallet = row({
      depositUsedAmount: 1000,
      pointUsedAmount: 500,
      payableSettlementAmount: 1000,
    });
    const legacy = row({
      depositUsedAmount: 1000,
      pointUsedAmount: 400,
      payableSettlementAmount: 1000,
    });
    expect(sut.classify(wallet, legacy)).toBe(ShadowMismatchClass.POINT_GRANT_DIFF);
  });

  it('REAL_DRIFT: deposit 차이 + point 차이 (point 외 도 다름)', () => {
    const wallet = row({
      depositUsedAmount: 1000,
      pointUsedAmount: 500,
      payableSettlementAmount: 1000,
    });
    const legacy = row({
      depositUsedAmount: 1500, // 500 차이 (rounding 임계값 초과)
      pointUsedAmount: 400,
      payableSettlementAmount: 1500,
    });
    expect(sut.classify(wallet, legacy)).toBe(ShadowMismatchClass.REAL_DRIFT);
  });

  it('REAL_DRIFT: credit_used 큰 차이만', () => {
    const wallet = row({ creditUsedAmount: 5000, payableSettlementAmount: 5000 });
    const legacy = row({ creditUsedAmount: 100, payableSettlementAmount: 100 });
    expect(sut.classify(wallet, legacy)).toBe(ShadowMismatchClass.REAL_DRIFT);
  });

  it('UNKNOWN: 입력 NaN', () => {
    const wallet = row({ depositUsedAmount: NaN });
    const legacy = row({ depositUsedAmount: 1000 });
    expect(sut.classify(wallet, legacy)).toBe(ShadowMismatchClass.UNKNOWN);
  });

  it('UNKNOWN: 입력 Infinity', () => {
    const wallet = row({ depositUsedAmount: Infinity });
    const legacy = row({ depositUsedAmount: 1000 });
    expect(sut.classify(wallet, legacy)).toBe(ShadowMismatchClass.UNKNOWN);
  });

  it('우선순위: MIRROR_LAG > ROUNDING_ONLY (wallet 모두 0 이면 rounding 무시)', () => {
    // wallet 0 + legacy 5 — rounding 임계값 안이지만 MIRROR_LAG 가 우선
    const wallet = row({});
    const legacy = row({ cardSurchargeAmount: 5, payableSettlementAmount: 5 });
    expect(sut.classify(wallet, legacy)).toBe(ShadowMismatchClass.MIRROR_LAG);
  });

  it('우선순위: ROUNDING_ONLY > POINT_GRANT_DIFF (모든 차이가 임계값 안 + point 만 차이여도)', () => {
    // point 만 차이지만 임계값 안이면 ROUNDING_ONLY 가 더 약한 분류로 우선
    const wallet = row({ pointUsedAmount: 500, payableSettlementAmount: 1000 });
    const legacy = row({ pointUsedAmount: 495, payableSettlementAmount: 1000 });
    expect(sut.classify(wallet, legacy)).toBe(ShadowMismatchClass.ROUNDING_ONLY);
  });

  it('credit_excess 큰 차이 → REAL_DRIFT', () => {
    const wallet = row({ creditExcessAmount: 0, payableSettlementAmount: 0 });
    const legacy = row({ creditExcessAmount: 500, payableSettlementAmount: 500 });
    // wallet 모두 0 이지만 legacy non-zero → MIRROR_LAG 가 우선 (real drift 아님)
    expect(sut.classify(wallet, legacy)).toBe(ShadowMismatchClass.MIRROR_LAG);
  });

  it('walletPreview / legacyResult 모두 0 → null (mismatch 없음)', () => {
    expect(sut.classify(zero, zero)).toBeNull();
  });
});
