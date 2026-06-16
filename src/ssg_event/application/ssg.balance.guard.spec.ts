import { evaluateSsgEventSignals } from './ssg.balance.guard';

const base = {
  ssgEventId: 1,
  eventName: '행사A',
  eventBalance: 0,
  eventPrice: 0,
  successAmt: 0,
  failAmt: 0,
  pendingAmt: 0,
  openTempDeduction: 0, // R
  orderAmount: 0,       // A_E
  tol: 0,
};

describe('evaluateSsgEventSignals', () => {
  it('정합 상태(ρ=0, fail=0, 잔액충분)면 경고 없음', () => {
    const r = evaluateSsgEventSignals({ ...base, eventBalance: 1000, eventPrice: 1000, orderAmount: 10 });
    expect(r.signals).toEqual({ A1_issueFail: false, A2_overRefund: false, B_capacityRisk: false });
    expect(r.hasWarning).toBe(false);
  });

  it('A1: 발급실패>0 이면 금액 무관 항상 경고', () => {
    const r = evaluateSsgEventSignals({ ...base, eventBalance: 995, eventPrice: 1000, failAmt: 5, orderAmount: 1 });
    expect(r.signals.A1_issueFail).toBe(true);
    expect(r.hasWarning).toBe(true);
  });

  it('A2: 우리 잔액 부풀음(ρ>0=이중환불) 경고', () => {
    const r = evaluateSsgEventSignals({ ...base, eventBalance: 1010, eventPrice: 1000, orderAmount: 1 });
    expect(r.signals.A2_overRefund).toBe(true);
    expect(r.rho).toBe(10);
    expect(r.hasWarning).toBe(true);
  });

  it('우리<SSG(ρ<0)는 A2 경고 안 함', () => {
    const r = evaluateSsgEventSignals({ ...base, eventBalance: 990, eventPrice: 1000, orderAmount: 1 });
    expect(r.signals.A2_overRefund).toBe(false);
    expect(r.rho).toBe(-10);
  });

  it('B: SSG 발급여력(P-S-Pend) < 이 주문 금액이면 경고', () => {
    const r = evaluateSsgEventSignals({ ...base, eventBalance: 5, eventPrice: 1000, successAmt: 995, orderAmount: 10 });
    expect(r.signals.B_capacityRisk).toBe(true);
    expect(r.hasWarning).toBe(true);
  });

  it('미처리만의 차이 + 잔액 충분이면 경고 안 함 (사용자 예시: 950 남고 주문 1만)', () => {
    const r = evaluateSsgEventSignals({
      ...base,
      eventBalance: 9_500_000,
      eventPrice: 10_000_000,
      pendingAmt: 500_000,
      openTempDeduction: 0,
      orderAmount: 10_000,
    });
    expect(r.hasWarning).toBe(false);
  });

  it('tol 버퍼: ρ가 tol 이하면 A2 안 울림', () => {
    const r = evaluateSsgEventSignals({ ...base, eventBalance: 1003, eventPrice: 1000, orderAmount: 1, tol: 5 });
    expect(r.signals.A2_overRefund).toBe(false);
  });

  it('reasons 문구는 걸린 신호만큼 채워진다', () => {
    const r = evaluateSsgEventSignals({ ...base, eventBalance: 1010, eventPrice: 1000, failAmt: 5, orderAmount: 1 });
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });
});
