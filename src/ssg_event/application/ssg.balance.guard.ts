export interface SsgEventSignalInput {
  ssgEventId: number;
  eventName: string;
  eventBalance: number; // Bal
  eventPrice: number; // P
  successAmt: number; // S
  failAmt: number; // F
  pendingAmt: number; // Pend
  openTempDeduction: number; // R = Σ|amount| isTemporary=true (이 행사)
  orderAmount: number; // A_E
  tol: number; // 기본 0
}

export interface SsgBalanceCheckResult {
  hasWarning: boolean;
  lookupFailed: boolean;
  events: SsgEventSignalResult[];
}

export interface SsgEventSignalResult {
  ssgEventId: number;
  eventName: string;
  ourBalance: number;
  orderAmount: number;
  ssg: { tryAmt: number; successAmt: number; failAmt: number; pendingAmt: number };
  rho: number;
  ssgRemaining: number;
  signals: { A1_issueFail: boolean; A2_overRefund: boolean; B_capacityRisk: boolean };
  reasons: string[];
  hasWarning: boolean;
}

// ── 응답 전용 계약 ────────────────────────────────────────────
// 내부 판정 타입(SsgEventSignalResult)을 API 응답에 그대로 쓰면 내부 필드 추가가 곧
// API 계약 변경이 된다. 응답 전용 View + mapper 로 노출 필드를 명시적으로 고정한다.
// (rho/ssgRemaining/per-event hasWarning 은 발송확정 권한 게이트 뒤라 운영자 디버깅용으로 유지)
export interface SsgEventSignalView {
  ssgEventId: number;
  eventName: string;
  ourBalance: number;
  orderAmount: number;
  ssg: { tryAmt: number; successAmt: number; failAmt: number; pendingAmt: number };
  rho: number;
  ssgRemaining: number;
  signals: { A1_issueFail: boolean; A2_overRefund: boolean; B_capacityRisk: boolean };
  reasons: string[];
  hasWarning: boolean;
}

export interface SsgBalanceCheckView {
  hasWarning: boolean;
  lookupFailed: boolean;
  events: SsgEventSignalView[];
}

export function toSsgBalanceCheckView(r: SsgBalanceCheckResult): SsgBalanceCheckView {
  // 노출 필드를 명시적으로 나열한다(스프레드 금지). 내부 SsgEventSignalResult 에 필드가
  // 추가돼도 여기서 골라 담은 것만 응답에 실려, 내부 변경이 API 계약으로 자동 누설되지 않는다.
  return {
    hasWarning: r.hasWarning,
    lookupFailed: r.lookupFailed,
    events: r.events.map((e) => ({
      ssgEventId: e.ssgEventId,
      eventName: e.eventName,
      ourBalance: e.ourBalance,
      orderAmount: e.orderAmount,
      ssg: { ...e.ssg },
      rho: e.rho,
      ssgRemaining: e.ssgRemaining,
      signals: { ...e.signals },
      reasons: [...e.reasons],
      hasWarning: e.hasWarning,
    })),
  };
}

export function evaluateSsgEventSignals(i: SsgEventSignalInput): SsgEventSignalResult {
  const { eventBalance: Bal, eventPrice: P, successAmt: S, failAmt: F, pendingAmt: Pend } = i;
  const R = i.openTempDeduction;
  const tryAmt = S + F + Pend;

  const rho = Bal - P + R + S + F + Pend;
  const ssgRemaining = P - S - Pend;

  const A1 = F > 0;
  const A2 = rho > i.tol;
  const B = ssgRemaining < i.orderAmount;

  const reasons: string[] = [];
  if (A1) reasons.push(`신세계 발급실패 ${F.toLocaleString()}원 존재(미해결). 가짜 쿠폰 위험.`);
  if (A2) reasons.push(`우리 잔액이 신세계 집계보다 ${rho.toLocaleString()}원 부풀어 있습니다(과다환불 의심).`);
  if (B)
    reasons.push(
      `신세계 발급여력(${ssgRemaining.toLocaleString()}원)이 이 주문 금액(${i.orderAmount.toLocaleString()}원)보다 부족합니다.`,
    );

  return {
    ssgEventId: i.ssgEventId,
    eventName: i.eventName,
    ourBalance: Bal,
    orderAmount: i.orderAmount,
    ssg: { tryAmt, successAmt: S, failAmt: F, pendingAmt: Pend },
    rho,
    ssgRemaining,
    signals: { A1_issueFail: A1, A2_overRefund: A2, B_capacityRisk: B },
    reasons,
    hasWarning: A1 || A2 || B,
  };
}
