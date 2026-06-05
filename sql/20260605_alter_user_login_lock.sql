-- 2026-06-05 로그인 5회 실패 영구 잠금 (PR1-lock)
-- 운영 DATABASE_SYNCHRONIZE=false → 배포 전 수동 적용 필요
-- 영구 잠금: is_login_locked. locked_until/lock_reason 미사용 (영구잠금 설계)

ALTER TABLE `user`
  ADD COLUMN `login_fail_count` INT NOT NULL DEFAULT 0 COMMENT '연속 로그인 실패 횟수';

ALTER TABLE `user`
  ADD COLUMN `is_login_locked` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '로그인 영구 잠금 여부 (관리자 해제)';

ALTER TABLE `user`
  ADD COLUMN `locked_at` DATETIME NULL COMMENT '잠금 발생 시각 (감사용)';
