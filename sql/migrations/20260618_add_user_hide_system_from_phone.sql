-- user.hide_system_from_phone 컬럼 추가
-- 배경: 시스템 기본 발신번호(16443614)는 모든 계정의 MMS 발신번호 선택목록에 무조건 노출됨.
--       자체 인증 발신번호를 등록·기본 설정해 쓰는 고객사가 16443614 노출을 불필요하게 느껴
--       선택목록에서 숨기길 원함.
-- 동작: 표시 전용 플래그. 알림톡/시스템메시지/발송 안전망의 16443614 사용은 그대로 유지.
--       MMS 발신번호 드롭다운에서 시스템 기본번호 옵션만 숨긴다.
--       (단, 승인 발신번호가 0개면 드롭다운이 비지 않도록 앱 레이어에서 숨김을 무시한다)
-- 제어: 고객사 본인(발신번호 관리) + 운영 관리자(고객사 계정 편집) 양쪽에서 토글.
--
-- 적용 환경: MySQL 8.x. 기본값 0(노출 유지)이라 기존 계정 동작 변화 없음.
-- 적용 절차: sql/RUNBOOK.md (staging dry-run → RDS 스냅샷 → prod 적용).

ALTER TABLE `user`
  ADD COLUMN `hide_system_from_phone` TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'MMS 발신번호 선택목록에서 시스템 기본번호(16443614) 숨김 여부';

-- 검증
--   SHOW COLUMNS FROM `user` LIKE 'hide_system_from_phone';
--   SELECT id, email, hide_system_from_phone FROM `user` LIMIT 5;
--
-- 롤백
--   ALTER TABLE `user` DROP COLUMN `hide_system_from_phone`;
