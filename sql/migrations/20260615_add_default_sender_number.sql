-- 모든 계정에 자사 공용 발신번호 16443614 추가
--
-- 정책:
--   - 16443614 = 자사가 이미 통신이용증명을 받은 인증 번호 → request_status='APPROVED', telecom_cert_type='PRE_DELIVERED'
--   - 계정당 1건씩만 추가. 이미 16443614 를 가진 계정은 건너뜀(재실행 안전, NOT EXISTS).
--   - 기존 기본 발신번호가 "없는" 계정 → 16443614 를 기본(is_default=1)으로 설정.
--   - 기존 기본 발신번호가 "있는" 계정 → 16443614 는 일반 번호(is_default=0)로만 추가(기존 기본 미변경).
--   - 탈퇴(LEAVE)/소프트삭제 계정은 제외.
--
-- 참고: order_from_definition 의 (user_id, type=PHONE, is_default=1) 은 setDefault 로직상 계정당 1건 불변식.
--       위 분기로 이 불변식을 깨지 않는다.

INSERT INTO `order_from_definition`
  (`type`, `user_id`, `from`, `request_status`, `is_default`,
   `telecom_cert_type`, `telecom_cert_file`, `reject_reason`,
   `created_at`, `updated_at`)
SELECT
  'PHONE',
  u.id,
  '16443614',
  'APPROVED',
  CASE WHEN EXISTS (
    SELECT 1
    FROM `order_from_definition` d
    WHERE d.user_id = u.id
      AND d.type = 'PHONE'
      AND d.is_default = 1
      AND d.deleted_at IS NULL
  ) THEN 0 ELSE 1 END,
  'PRE_DELIVERED',
  NULL,
  NULL,
  NOW(6),
  NOW(6)
FROM `user` u
WHERE u.deleted_at IS NULL
  AND u.status <> 'LEAVE'
  AND NOT EXISTS (
    SELECT 1
    FROM `order_from_definition` x
    WHERE x.user_id = u.id
      AND x.type = 'PHONE'
      AND x.`from` = '16443614'
      AND x.deleted_at IS NULL
  );

-- user.from_phone_number 채우기
--   - user.from_phone_number = 계정 단위 발신번호 필드. 시스템 SMS(비밀번호 초기화/로그인 인증코드)
--     발신번호로 직접 사용되며, 비어 있으면 해당 문자 발신이 깨진다.
--   - 비파괴 원칙: 이미 값이 있는 계정은 건드리지 않고, NULL/빈 문자열인 계정만 16443614 로 채운다.
--   - 탈퇴(LEAVE)/소프트삭제 계정은 제외.
--   - 참고: 발송 시점 fallback 상수(const.ts defaultFromPhoneNumber) 도 이미 '16443614' 라
--     이 값과 일치한다.
UPDATE `user`
SET `from_phone_number` = '16443614'
WHERE (`from_phone_number` IS NULL OR `from_phone_number` = '')
  AND `deleted_at` IS NULL
  AND `status` <> 'LEAVE';

-- 검증용 (실행 후 확인):
-- SELECT COUNT(*) FROM order_from_definition WHERE `from` = '16443614' AND deleted_at IS NULL;
-- SELECT COUNT(*) FROM `user` WHERE from_phone_number = '16443614' AND deleted_at IS NULL;
SELECT user_id, COUNT(*) c FROM order_from_definition
   WHERE type='PHONE' AND is_default=1 AND deleted_at IS NULL
   GROUP BY user_id HAVING c > 1;  -- 결과 0건이어야 정상(기본번호 중복 없음)
