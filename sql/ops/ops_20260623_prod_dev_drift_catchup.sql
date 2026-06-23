-- ============================================================================
-- 상용 ↔ 개발 스키마 드리프트 따라잡기 (2026-06-23)
-- ============================================================================
-- 출처: sql/snapshots/prod_db.md (상용) vs sql/snapshots/test_db.md (개발) 정밀 비교.
--
-- 범위: "위험 0 + 코드와 정합" 항목만. 라이브 정산 로직(user_company 기준 은퇴)은
--       의도적으로 제외 — 아직 레거시 분기가 살아있어 별도 PR5 시퀀스로 처리한다(§아래 보류).
--
-- ⚠️ 각 환경에 "해당 섹션만" 실행할 것. PROD 섹션을 DEV에, DEV 섹션을 PROD에 돌리지 말 것.
-- ⚠️ 실행 전 백업 권장. MySQL 8.4 는 DROP COLUMN IF EXISTS 미지원이라 존재 여부 먼저 확인.
-- ============================================================================


-- ============================================================================
-- [DEV 전용] 개발서버가 뒤처진 항목
-- ============================================================================

-- D1. giftiel_exchange_history 테이블 (개발 누락, 상용 보유)
--   라이브 기능: GiftielPushController + partner.company.extern.service.ts 가 사용.
--   개발에 없으면 giftiel push/SSG 교환 흐름이 깨진다.
--   → 정식 마이그레이션 파일을 그대로 실행한다(아래 DDL 중복 작성 금지, 단일 출처 유지):
--
--       source sql/migrations/20260422_create_giftiel_exchange_history.sql
--
--   (mysql CLI: `\. sql/migrations/20260422_create_giftiel_exchange_history.sql`)
--   적용 후 확인: SHOW TABLES LIKE 'giftiel_exchange_history';


-- D2. order.send_title 잔재 제거 (개발에만 남음, 상용은 제거됨)
--   order 엔티티에 send_title 필드 없음 → INSERT 시 항상 누락.
--   개발 컬럼은 NOT NULL + default 없음 → order INSERT 가 깨질 수 있음(잠재 버그).
--   상용은 legacy/order.sql 의 DROP 으로 이미 제거된 상태.
--   실행 전 확인:
--     SELECT COUNT(*) FROM information_schema.COLUMNS
--       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order' AND COLUMN_NAME = 'send_title';
ALTER TABLE `order` DROP COLUMN `send_title`;


-- ============================================================================
-- [PROD 전용] 상용이 뒤처진 항목
-- ============================================================================

-- P1. user.maximum_limit 죽은 컬럼 제거 (상용에만 남음, 개발은 제거됨)
--   UserEntity 에 maximumLimit 필드 없음 + 코드 참조 0건 = 완전 사장된 컬럼.
--   (주의: 코드가 쓰는 건 user_company.maximum_limit 이며 그건 별개 — §보류 참조. 이건 user 테이블.)
--   2024-12-29 마이그레이션(migrations/20241229_remove_user_maximum_limit.sql) 미적용분.
--   실행 전 확인:
--     SELECT COUNT(*) FROM information_schema.COLUMNS
--       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = 'maximum_limit';
ALTER TABLE `user` DROP COLUMN `maximum_limit`;


-- ============================================================================
-- [보류 — 본 파일에서 실행하지 않음] 별도 판단/PR 필요
-- ============================================================================
-- 아래는 드리프트지만 위험 또는 시퀀스 의존이 있어 여기서 처리하지 않는다.
--
-- (1) user_company.maximum_limit / balance / balanceManagementType 은퇴
--     - order.service.ts 레거시 isCompanyBalanceMode 분기가 아직 사용(라이브).
--     - leftJoinAndSelect('user.company') 가 거의 모든 주문 쿼리에 있어 컬럼 drop 시
--       즉시 'Unknown column' 전면 장애.
--     - 정산코드(wallet) 단일 기준 수렴 완료 후 PR5 레거시 은퇴로 처리.
--
-- (2) 코드 미사용 잔재 (현 백엔드 src 참조 0건 — 배포 위험 없음, 청소만 선택적)
--     - DEV:  product_request, product_request_history 테이블
--             order_real_product_mapping.payment_bank, payment_account_info 컬럼
--     - PROD: order_from_definition.active_from_key (수동 추가된 generated UNIQUE 가드, 마이그레이션 파일 없음)
--     → 정말 미사용 확정 시 drop 가능하나, 출처 불명(마이그레이션 파일 없음)이라 보존 권장.
--
-- (3) 백업/임시 테이블 (스키마 아님, 보관 만료 후 정리)
--     - PROD: daou_orphan_pins_3161, order_delivery_bk_3160_20260407
--     - DEV:  _bak_all_settle_20260601
-- ============================================================================
