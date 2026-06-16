-- FORBIDDEN_WORD(금칙어 관리) 권한 백필.
--
-- 배경: 금칙어 관리 메뉴는 UserAuthSubEnum.FORBIDDEN_WORD 권한키로 게이트된다.
--  - SUPER_ADMIN  : UserAuthListDefault 가 Object.values(enum) 반환 → 자동 포함(코드만으로 해소)
--  - OPERATION_ADMIN(기본 권한, authority_list IS NULL) : default 목록에 추가됨(코드만으로 해소)
--  - 그러나 개별 권한이 저장된 계정(authority_list 非NULL CSV)은 default 를 완전 대체하므로
--    enum/메뉴매핑을 추가해도 FORBIDDEN_WORD 가 영영 내려가지 않는다 → 본 백필 필요.
--
-- 정책: 운영관리자(OPERATION_ADMIN) 기본 권한에 FORBIDDEN_WORD 가 포함되도록 변경됐으므로,
--       커스텀 권한이 저장된 운영관리자 계정에도 동일하게 append 한다.
--       (그 외 권한 등급은 default 에 FORBIDDEN_WORD 가 없으므로 백필 대상 아님)
--
-- 주의: 운영 정책상 특정 운영관리자에게 금칙어 메뉴를 막아야 한다면 본 백필 대신
--       권한관리 화면에서 개별 조정한다. 실행 전 (1) 영향 대상 SELECT 로 확인할 것.

-- (1) 영향 대상 미리보기 (실행 전 확인)
SELECT id, email, authority, authority_list
FROM `user`
WHERE authority = 'OPERATION_ADMIN'
  AND authority_list IS NOT NULL
  AND authority_list <> ''
  AND NOT FIND_IN_SET('FORBIDDEN_WORD', authority_list);

-- (2) 백필 — 커스텀 권한 운영관리자 CSV 에 FORBIDDEN_WORD append
UPDATE `user`
SET authority_list = CONCAT(authority_list, ',FORBIDDEN_WORD')
WHERE authority = 'OPERATION_ADMIN'
  AND authority_list IS NOT NULL
  AND authority_list <> ''
  AND NOT FIND_IN_SET('FORBIDDEN_WORD', authority_list);

-- (3) 검증 — 백필 후 남은 누락 건 = 0 이어야 정상
SELECT COUNT(*) AS leftover
FROM `user`
WHERE authority = 'OPERATION_ADMIN'
  AND authority_list IS NOT NULL
  AND authority_list <> ''
  AND NOT FIND_IN_SET('FORBIDDEN_WORD', authority_list);

-- (4) 롤백 (필요 시 — CSV 끝/중간의 FORBIDDEN_WORD 제거)
-- UPDATE `user`
-- SET authority_list = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', authority_list, ','), ',FORBIDDEN_WORD,', ','))
-- WHERE authority = 'OPERATION_ADMIN'
--   AND FIND_IN_SET('FORBIDDEN_WORD', authority_list);
