import { ActivityLogActionType } from './activity.log.action.type';

/**
 * activity_log 보존 정책 (단일 상수 출처 — 흔들림 금지).
 * 요구 "12개월 이상" 충족 + 여유로 24개월 고정.
 */
export const ACTIVITY_LOG_RETENTION_MONTHS = 24;

/**
 * purge 제외(장기 보존) actionType.
 * 정산/감사/계정 라이프사이클 로그는 보존기간 경과해도 삭제하지 않는다.
 */
export const ACTIVITY_LOG_PURGE_EXCLUDED_ACTION_TYPES: string[] = [
  ActivityLogActionType.BALANCE_CHARGE,
  ActivityLogActionType.BALANCE_MODIFY,
  ActivityLogActionType.BALANCE_REFUND,
  ActivityLogActionType.BALANCE_REFUND_REVERSE,
  ActivityLogActionType.MAXIMUM_LIMIT_MODIFY,
  ActivityLogActionType.SETTLE_CODE_POLICY_MODIFY,
  ActivityLogActionType.SETTLE_CODE_RENAME,
  ActivityLogActionType.DISCARD_RESTORE,
  ActivityLogActionType.ACCOUNT_CREATE,
  ActivityLogActionType.ACCOUNT_WITHDRAW,
  ActivityLogActionType.ACCOUNT_ANONYMIZE,
  ActivityLogActionType.SETTLE_DISCOUNT_MODIFY,
  ActivityLogActionType.SETTLE_DISCOUNT_AUTO_CAPTURE,
  ActivityLogActionType.API_ACCESS_CONFIG_MODIFY,
  ActivityLogActionType.PARTNER_SETTLE_VARIANCE_APPROVE,
  ActivityLogActionType.PARTNER_SETTLE_VARIANCE_REJECT,
];
