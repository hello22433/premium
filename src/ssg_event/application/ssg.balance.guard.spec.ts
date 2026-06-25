import { evaluateSsgEventSignals, toSsgBalanceCheckView } from './ssg.balance.guard';

const base = {
  ssgEventId: 1,
  eventName: '행사A',
  eventBalance: 0,
  eventPrice: 0,
  successAmt: 0,
  failAmt: 0,
  pendingAmt: 0,
  openTempDeduction: 0, // R
  orderAmount: 0, // A_E
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

  it('B 경계 등호: ssgRemaining===orderAmount 이면 B 경고 안 함(< 이지 <= 아님)', () => {
    const r = evaluateSsgEventSignals({ ...base, eventPrice: 1000, successAmt: 0, pendingAmt: 0, orderAmount: 1000 });
    expect(r.signals.B_capacityRisk).toBe(false);
  });

  it('B 경계 초과: orderAmount가 ssgRemaining보다 1 크면 B 경고', () => {
    const r = evaluateSsgEventSignals({ ...base, eventPrice: 1000, successAmt: 0, pendingAmt: 0, orderAmount: 1001 });
    expect(r.signals.B_capacityRisk).toBe(true);
  });

  it('A2 tol 경계 등호: ρ===tol 이면 A2 경고 안 함(> 이지 >= 아님)', () => {
    const r = evaluateSsgEventSignals({ ...base, eventBalance: 1005, eventPrice: 1000, orderAmount: 1, tol: 5 });
    expect(r.signals.A2_overRefund).toBe(false);
  });

  it('다중신호 동시: 세 플래그 모두 독립적으로 트리거되고 reasons가 3개', () => {
    // F>0 → A1, ρ>tol → A2(Bal=1010,P=1000,rho=10+5=15>tol=5), ssgRemaining=P-S-Pend=1000-990-0=10<orderAmount=11 → B
    const r = evaluateSsgEventSignals({
      ...base,
      eventBalance: 1010,
      eventPrice: 1000,
      successAmt: 990,
      failAmt: 5,
      pendingAmt: 0,
      openTempDeduction: 0,
      orderAmount: 11,
      tol: 5,
    });
    expect(r.signals).toEqual({ A1_issueFail: true, A2_overRefund: true, B_capacityRisk: true });
    expect(r.reasons.length).toBe(3);
  });
});

describe('toSsgBalanceCheckView (응답 전용 매핑)', () => {
  it('판정 결과의 노출 필드를 그대로 매핑하고 내부 참조를 복사한다', () => {
    const ev = evaluateSsgEventSignals({
      ...base,
      eventBalance: 1010,
      eventPrice: 1000,
      successAmt: 990,
      failAmt: 5,
      pendingAmt: 0,
      openTempDeduction: 0,
      orderAmount: 11,
      tol: 0,
    });
    const view = toSsgBalanceCheckView({ hasWarning: true, lookupFailed: false, events: [ev] });

    expect(view.hasWarning).toBe(true);
    expect(view.lookupFailed).toBe(false);
    expect(view.events).toHaveLength(1);
    expect(view.events[0]).toEqual({
      ssgEventId: ev.ssgEventId,
      eventName: ev.eventName,
      ourBalance: ev.ourBalance,
      orderAmount: ev.orderAmount,
      ssg: ev.ssg,
      rho: ev.rho,
      ssgRemaining: ev.ssgRemaining,
      signals: ev.signals,
      reasons: ev.reasons,
      hasWarning: ev.hasWarning,
    });
    // 내부 배열/객체를 복사해 응답이 내부 상태와 공유되지 않음
    expect(view.events[0].ssg).not.toBe(ev.ssg);
    expect(view.events[0].reasons).not.toBe(ev.reasons);
  });
});
