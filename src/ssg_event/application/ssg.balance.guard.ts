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
  if (B) reasons.push(`신세계 발급여력(${ssgRemaining.toLocaleString()}원)이 이 주문 금액(${i.orderAmount.toLocaleString()}원)보다 부족합니다.`);

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
