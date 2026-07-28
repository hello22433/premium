/**
 * 메시지(알림톡/SMS/MMS) 개별 시도 상태 (§5.3).
 *
 * 각 시도 행은 단일 `MSEQ` 에 고정된다. 재발송은 `retryOfAttemptId` 로 연결된 **새 행**을 만들며
 * 하나의 행에서 `MSEQ` 를 교체하지 않는다.
 *
 * `OUTBOX_READY` / `SUBMITTING` 분리가 핵심이다. 마크가 하나면 "외부 호출 전 크래시"와
 * "호출 후 응답 유실"을 구분할 수 없어 정상 발송까지 UNKNOWN 으로 stranded 된다.
 * - OUTBOX_READY : 제출 의도만 durable 커밋. **아직 Gemtek 을 호출하지 않았음이 확정** →
 *                  재조회 없이 동일 attemptId 로 최초 insert 를 그대로 수행(blind 재삽입 아님).
 * - SUBMITTING   : 호출 시작 마크 커밋 이후 → 발급 여부 불명. 크래시 시 RECONCILING 재조회만 허용,
 *                  blind (재)insert 금지.
 */
export enum MessageAttemptStatus {
  OUTBOX_READY = 'OUTBOX_READY',
  SUBMITTING = 'SUBMITTING',
  SUBMITTED = 'SUBMITTED',
  TRACKING = 'TRACKING',
  RECONCILING = 'RECONCILING',
  RETRY_SCHEDULED = 'RETRY_SCHEDULED',
  RETRIED = 'RETRIED',
  CANCELLED_SUPERSEDED = 'CANCELLED_SUPERSEDED',
  SUCCEEDED = 'SUCCEEDED',
  FAILED_FINAL = 'FAILED_FINAL',
  UNKNOWN = 'UNKNOWN',
}

/**
 * 신규 메시지 시도 생성을 막는 미확정 상태 집합 (§6.1 MESSAGE_SEND 가드).
 *
 * `UNKNOWN` 포함 이유: 외부 발송 여부가 불명인 시도가 남아 있는데 새 발송을 만들면 자사가 스스로
 * 이중 발송을 만든다. `RETRY_SCHEDULED` 포함 이유: 예약 자체가 이미 "다음 발송 계획"이다.
 */
export const MESSAGE_SEND_BLOCKING_STATUSES: MessageAttemptStatus[] = [
  MessageAttemptStatus.OUTBOX_READY,
  MessageAttemptStatus.SUBMITTING,
  MessageAttemptStatus.SUBMITTED,
  MessageAttemptStatus.TRACKING,
  MessageAttemptStatus.RECONCILING,
  MessageAttemptStatus.UNKNOWN,
  MessageAttemptStatus.RETRY_SCHEDULED,
];

/**
 * 예약 재발송(`RETRY` 메시지 변형) 실행을 막는 미확정 상태 집합 (§6.1 RETRY 가드).
 *
 * `RETRY_SCHEDULED` 는 **실행 대상**이므로 제외 집합에 두지 않는다(MESSAGE_SEND 가드와의 차이).
 */
export const MESSAGE_RETRY_BLOCKING_STATUSES: MessageAttemptStatus[] = [
  MessageAttemptStatus.OUTBOX_READY,
  MessageAttemptStatus.SUBMITTING,
  MessageAttemptStatus.SUBMITTED,
  MessageAttemptStatus.TRACKING,
  MessageAttemptStatus.RECONCILING,
  MessageAttemptStatus.UNKNOWN,
];

/**
 * `RETRY` **재개(resume) 변형**의 미확정 가드 집합 (§5.3 OUTBOX_READY 재개).
 *
 * 크래시로 `OUTBOX_READY` 에 정체된 `AUTO_504` 자식을 동일 attemptId 로 재개할 때 쓴다.
 * 재개 대상 자체가 `OUTBOX_READY` 이므로 due 가드(`MESSAGE_RETRY_BLOCKING_STATUSES`)처럼
 * `OUTBOX_READY` 를 제외 집합에 두면 재개가 항상 막힌다 — 그 외 미확정만 금지한다.
 */
export const MESSAGE_RETRY_RESUME_BLOCKING_STATUSES: MessageAttemptStatus[] = [
  MessageAttemptStatus.SUBMITTING,
  MessageAttemptStatus.SUBMITTED,
  MessageAttemptStatus.TRACKING,
  MessageAttemptStatus.RECONCILING,
  MessageAttemptStatus.UNKNOWN,
];

/**
 * `CANCEL_INFLIGHT_SEND` 취소 대상 상태 집합 (§6.1 표 2-1).
 *
 * `OUTBOX_READY`/`SUBMITTING` 은 외부 취소 API 가 필요 없어 Gemtek 계약과 무관하게 항상 유효하고,
 * `SUBMITTED`/`TRACKING` 만 원자적 취소 수단 확정(§9)을 전제로 한다.
 */
export const MESSAGE_INFLIGHT_STATUSES: MessageAttemptStatus[] = [
  MessageAttemptStatus.OUTBOX_READY,
  MessageAttemptStatus.SUBMITTING,
  MessageAttemptStatus.SUBMITTED,
  MessageAttemptStatus.TRACKING,
];

/**
 * 시도 유형과 체인당 허용 횟수 (§5.3 표 / §9 확정).
 *
 * - INITIAL          : 최초 시도(`retryOfAttemptId IS NULL`, `rootAttemptId = attemptId`)
 * - AUTO_504         : 504 자동 재발송. **체인당 1회**(`(rootAttemptId, 'AUTO_504')` unique)
 * - CHANNEL_FALLBACK : 알림톡 → SMS 폴백. 원 attempt 당 1회
 * - MANUAL_RESEND    : 운영자 수동 재발송. 다회 허용(`attemptSeq` 포함)
 */
export enum MessageAttemptType {
  INITIAL = 'INITIAL',
  AUTO_504 = 'AUTO_504',
  CHANNEL_FALLBACK = 'CHANNEL_FALLBACK',
  MANUAL_RESEND = 'MANUAL_RESEND',
}

/** 메시지 채널 */
export enum MessageAttemptChannel {
  SMS = 'SMS',
  MMS = 'MMS',
  ALIM_TALK = 'ALIM_TALK',
}

/**
 * 취소 의도(cancel intent) 종결값 (§5.3 HIGH 3).
 *
 * 열린 intent(`cancelRequestedAt IS NOT NULL AND cancelResolution IS NULL`)를 남기지 않는다.
 * `UNKNOWN` 으로 남는 경로도 `UNKNOWN_REQUIRES_OPS` 로 닫고 운영 승격으로 넘긴다(§10 불변식 ③).
 */
export enum MessageCancelResolution {
  /** 취소 성공 → attempt CANCELLED_SUPERSEDED */
  CANCELLED = 'CANCELLED',
  /** 취소 수단 없음·cutoff 경과·rowcount=0 → 이중 발송 명시 수용 */
  ACCEPTED_DUPLICATE = 'ACCEPTED_DUPLICATE',
  /** 취소 확정 전 최종 성공이 확정됨 → SUCCEEDED 전이와 같은 트랜잭션에서 intent 종결 */
  TOO_LATE_DELIVERED = 'TOO_LATE_DELIVERED',
  /** 재조회 복수·조회 실패·재조정 SLA 초과 → attempt UNKNOWN + WF OPS_REVIEW_REQUIRED */
  UNKNOWN_REQUIRES_OPS = 'UNKNOWN_REQUIRES_OPS',
  /** 운영이 OPS_RESOLVE 로 종결하며 잔여 intent 를 함께 닫음 */
  OPS_CLOSED = 'OPS_CLOSED',
}

/** 취소 요청 사유 (§3 나·§7.2) */
export enum MessageCancelReason {
  OTHER_CHANNEL_DELIVERED = 'OTHER_CHANNEL_DELIVERED',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  OPS_REQUESTED = 'OPS_REQUESTED',
}
