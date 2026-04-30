-- 주문 시점의 사용자/회사 정보를 스냅샷으로 보관
-- 배경: 계정관리에서 담당자/이메일/회사정보가 변경되면 과거 주문의 거래명세서/정산/상세에서
--        변경된 정보로 조회되어, 1년 전 주문이 현재 담당자 명의로 보이는 문제가 발생.
-- 해결: 주문 생성 시점의 user / clientUser / operationUser 정보를 order 테이블에 복사 보관.
--        조회 시 snapshot 우선, NULL인 경우 기존 user FK join 값으로 fallback.

-- 1. user 스냅샷 (주문 발주자 / 직발송 시 과금 대상)
ALTER TABLE `order`
  ADD COLUMN snapshot_person_name VARCHAR(100) NULL COMMENT '주문 시점의 user.personName 스냅샷',
  ADD COLUMN snapshot_person_phone VARCHAR(20) NULL COMMENT '주문 시점의 user.personPhoneNumber 스냅샷',
  ADD COLUMN snapshot_email VARCHAR(100) NULL COMMENT '주문 시점의 user.email 스냅샷',
  ADD COLUMN snapshot_business_name VARCHAR(100) NULL COMMENT '주문 시점의 user.company.businessName 스냅샷',
  ADD COLUMN snapshot_business_number VARCHAR(100) NULL COMMENT '주문 시점의 user.company.businessNumber 스냅샷',
  ADD COLUMN snapshot_business_address VARCHAR(255) NULL COMMENT '주문 시점의 user.company.businessAddress 스냅샷',
  ADD COLUMN snapshot_industry_type VARCHAR(100) NULL COMMENT '주문 시점의 user.company.industryType 스냅샷',
  ADD COLUMN snapshot_industry_item VARCHAR(100) NULL COMMENT '주문 시점의 user.company.industryItem 스냅샷',
  ADD COLUMN snapshot_settle_condition VARCHAR(20) NULL COMMENT '주문 시점의 user.settleCondition 스냅샷',
  ADD COLUMN snapshot_document_company_type VARCHAR(20) NULL COMMENT '주문 시점의 user.documentCompanyType 스냅샷';

-- 2. clientUser 스냅샷 (대행주문 시 과금 대상)
ALTER TABLE `order`
  ADD COLUMN snapshot_client_person_name VARCHAR(100) NULL COMMENT '주문 시점의 clientUser.personName 스냅샷',
  ADD COLUMN snapshot_client_person_phone VARCHAR(20) NULL COMMENT '주문 시점의 clientUser.personPhoneNumber 스냅샷',
  ADD COLUMN snapshot_client_email VARCHAR(100) NULL COMMENT '주문 시점의 clientUser.email 스냅샷',
  ADD COLUMN snapshot_client_business_name VARCHAR(100) NULL COMMENT '주문 시점의 clientUser.company.businessName 스냅샷',
  ADD COLUMN snapshot_client_business_number VARCHAR(100) NULL COMMENT '주문 시점의 clientUser.company.businessNumber 스냅샷',
  ADD COLUMN snapshot_client_business_address VARCHAR(255) NULL COMMENT '주문 시점의 clientUser.company.businessAddress 스냅샷',
  ADD COLUMN snapshot_client_industry_type VARCHAR(100) NULL COMMENT '주문 시점의 clientUser.company.industryType 스냅샷',
  ADD COLUMN snapshot_client_industry_item VARCHAR(100) NULL COMMENT '주문 시점의 clientUser.company.industryItem 스냅샷',
  ADD COLUMN snapshot_client_settle_condition VARCHAR(20) NULL COMMENT '주문 시점의 clientUser.settleCondition 스냅샷',
  ADD COLUMN snapshot_client_document_company_type VARCHAR(20) NULL COMMENT '주문 시점의 clientUser.documentCompanyType 스냅샷';

-- 3. operationUser 스냅샷 (운영 담당자명)
ALTER TABLE `order`
  ADD COLUMN snapshot_operation_person_name VARCHAR(100) NULL COMMENT '주문 시점의 operationUser.personName 스냅샷';

-- 4. 기존 데이터 백필
-- 주의: 이미 변경된 user 정보로 채워질 수 있어 "주문 당시 정확한 정보" 복원은 불가.
--        이는 본 마이그레이션 도입 전 변경된 건에 대해 감수.
UPDATE `order` o
JOIN `user` u ON u.id = o.user_id
LEFT JOIN user_company uc ON uc.id = u.company_id
SET
  o.snapshot_person_name = u.person_name,
  o.snapshot_person_phone = u.person_phone_number,
  o.snapshot_email = u.email,
  o.snapshot_business_name = uc.business_name,
  o.snapshot_business_number = uc.business_number,
  o.snapshot_business_address = uc.business_address,
  o.snapshot_industry_type = uc.industry_type,
  o.snapshot_industry_item = uc.industry_item,
  o.snapshot_settle_condition = u.settle_condition,
  o.snapshot_document_company_type = u.document_company_type
WHERE o.snapshot_person_name IS NULL;

UPDATE `order` o
JOIN `user` cu ON cu.id = o.client_user_id
LEFT JOIN user_company cuc ON cuc.id = cu.company_id
SET
  o.snapshot_client_person_name = cu.person_name,
  o.snapshot_client_person_phone = cu.person_phone_number,
  o.snapshot_client_email = cu.email,
  o.snapshot_client_business_name = cuc.business_name,
  o.snapshot_client_business_number = cuc.business_number,
  o.snapshot_client_business_address = cuc.business_address,
  o.snapshot_client_industry_type = cuc.industry_type,
  o.snapshot_client_industry_item = cuc.industry_item,
  o.snapshot_client_settle_condition = cu.settle_condition,
  o.snapshot_client_document_company_type = cu.document_company_type
WHERE o.client_user_id IS NOT NULL
  AND o.snapshot_client_person_name IS NULL;

UPDATE `order` o
JOIN `user` ou ON ou.id = o.operation_user_id
SET o.snapshot_operation_person_name = ou.person_name
WHERE o.operation_user_id IS NOT NULL
  AND o.snapshot_operation_person_name IS NULL;
