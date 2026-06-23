-- 2026-06-09 계정 라이프사이클/휴면 자동전환 (C+D PR1)
-- 운영 DATABASE_SYNCHRONIZE=false → 배포 전 수동 적용 필요
--
-- last_activity_at: 휴면 판정 기준 (로그인 OR 외부 API 인증). last_login 아님.
-- backfill 필수: NOT NULL + IS NULL 분기 금지(배치). 컬럼은 항상 값 보유.
--   backfill 값 = COALESCE(마지막 주문일, updated_at, created_at)
-- suspended_at / withdrawn_at: 단계 경과(+6개월) 계산 기준.

-- 1) NULL 허용으로 먼저 추가 (backfill 전)
ALTER TABLE `user`
  ADD COLUMN `last_activity_at` DATETIME NULL COMMENT '마지막 활동 시각 (로그인 OR 외부 API 인증). 휴면 판정 기준',
  ADD COLUMN `suspended_at` DATETIME NULL COMMENT '휴면(NOT_USED) 전환 시각. 탈퇴 +6개월 계산 기준',
  ADD COLUMN `withdrawn_at` DATETIME NULL COMMENT '탈퇴(LEAVE) 전환 시각. 익명화 +6개월 계산 기준',
  ADD COLUMN `anonymized_at` DATETIME NULL COMMENT 'PII 익명화 처리 시각. 익명화 멱등성 게이트 (NULL=미처리)';

-- 2) 기존 계정 backfill (가용 최선 활동신호)
UPDATE `user` u
SET u.last_activity_at = COALESCE(
  (SELECT MAX(o.created_at) FROM `order` o WHERE o.user_id = u.id),
  u.updated_at,
  u.created_at
)
WHERE u.last_activity_at IS NULL;

-- 3) backfill 후 NOT NULL 제약 적용 (배치의 IS NULL 분기 금지 보장)
ALTER TABLE `user`
  MODIFY COLUMN `last_activity_at` DATETIME NOT NULL COMMENT '마지막 활동 시각 (로그인 OR 외부 API 인증). 휴면 판정 기준';

-- 4) email_send_history.type enum 에 REACTIVATE 추가 (휴면 재활성화 본인인증)
--    기존 값(LOGIN/PASSWORD/COUPON) 유지 + REACTIVATE 추가. 없으면 재활성화 코드 INSERT 시 실패.
ALTER TABLE `email_send_history`
  MODIFY COLUMN `type` ENUM('LOGIN', 'PASSWORD', 'COUPON', 'REACTIVATE') NOT NULL COMMENT '이메일 인증 type (LOGIN/PASSWORD/COUPON/REACTIVATE)';
