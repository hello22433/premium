-- PR1b Wallet: 공통 SSG 포인트 사용 DENY 시드
-- 시스템 기본은 ALLOW 이지만 SSG 권종은 공통 DENY (Global Verification Matrix).
-- 고객사 예외 (owner_type=COMPANY) 로 특정 고객사에만 ALLOW 가능.

INSERT INTO point_policy_rule (owner_type, owner_id, effect, scope_type, scope_code, active)
VALUES
  ('COMMON', NULL, 'DENY', 'PARTNER_COMPANY', 'SSG', 1),
  ('COMMON', NULL, 'DENY', 'ORDER_TYPE',      'SSG', 1),
  ('COMMON', NULL, 'DENY', 'BRAND',           '신세계', 1);
