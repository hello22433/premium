export enum IOrderDeliveryReportState {
  PENDING = 'PENDING', // 알림톡 POST 수락 후 수신리포트 확인 대기 (reportSweep 대상)
  CONFIRMED = 'CONFIRMED', // inquiry reportCode=10000 도착 확정 (터미널)
  UNCONFIRMED = 'UNCONFIRMED', // 마감/시도 소진까지 미확정 → SMS 폴백/FAIL 로 종결 (터미널)
}

/** reportSweep 타이밍 (ms). 첫 inquiry 까지 30초, 확인 마감 120초, sweep claim lease 120초. */
export const REPORT_NEXT_DUE_MS = 30_000;
export const REPORT_DEADLINE_MS = 120_000;
export const REPORT_CLAIM_LEASE_MS = 120_000;
export const REPORT_MAX_INQUIRY_ATTEMPTS = 2;
export const REPORT_SWEEP_BATCH_LIMIT = 200;
