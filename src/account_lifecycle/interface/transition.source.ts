/** 상태 전이 출처 — activity_log requestParams.source 에 기록 */
export enum TransitionSource {
  MANUAL = 'MANUAL', // 사용자 본인 (수동 탈퇴 등)
  DORMANT_BATCH = 'DORMANT_BATCH', // 휴면 자동전환 배치
  ADMIN = 'ADMIN', // 관리자 (user-management)
}
