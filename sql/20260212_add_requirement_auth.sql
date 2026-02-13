-- 기존 사용자의 authority_list에 REQUIREMENT 권한 추가
-- SUPER_ADMIN, OPERATION_ADMIN 중 authority_list가 커스텀 설정된 사용자에게
-- REQUIREMENT가 없는 경우에만 추가
--
-- 배경: 개발지원요청(Requirement) 기능 추가 시, 하드코딩 기본값은 수정했으나
-- DB에 이미 커스텀 권한이 저장된 사용자는 기본값이 무시되어 메뉴가 보이지 않음
-- 참고: TypeORM SnakeNamingStrategy로 인해 엔티티의 authorityList → DB에서는 authority_list

UPDATE user
SET authority_list = CONCAT(authority_list, ',REQUIREMENT')
WHERE authority IN ('SUPER_ADMIN', 'OPERATION_ADMIN')
  AND authority_list IS NOT NULL
  AND authority_list NOT LIKE '%REQUIREMENT%';
