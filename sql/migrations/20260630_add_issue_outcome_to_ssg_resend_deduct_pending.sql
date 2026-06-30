-- SSG 재발급 선차감 pending 에 issue 결과(재사용 여부) durable 컬럼 추가.
-- 배치가 새 행사(C) 선차감 후 issue() 가 기존/후보 PIN(B) 을 재사용한 직후, C 역복원 전에 크래시하면
-- sweep 이 재사용 PIN 의 CONFIRMED state 를 새 행사 등록 성공으로 오판하여 C 를 KEPT 처리하던 문제(HIGH) 수정.
-- issue() 가 재사용 시점에 issue_outcome='REUSED' 를 즉시(REQUIRES_NEW) 기록 → sweep 이 state 와 무관하게 REVERSED.
--
-- additive nullable 컬럼 → 구버전 코드 무해(NULL=기존 state 기준 확정 경로). 배포 전/후 무관하게 안전.

ALTER TABLE `ssg_resend_deduct_pending`
  ADD COLUMN `issue_outcome` VARCHAR(20) NULL COMMENT 'REUSED=기존/후보 PIN 재사용(선차감 미사용). NULL=신규발급/미상'
  AFTER `resolution`;
