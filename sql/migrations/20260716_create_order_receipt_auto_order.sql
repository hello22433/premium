-- 주문접수 자동주문(집행신청서 승인→자동 TEMP 주문 생성) 테이블 생성
-- 프로덕션 환경은 DATABASE_SYNCHRONIZE="false"이므로 수동 마이그레이션 필요
-- TypeORM SnakeNamingStrategy 기준 snake_case 컬럼명 사용
-- createForeignKeyConstraints 미사용(raw id 컬럼) → DB FK 제약조건 없음

-- 1) order_receipt_generated_order (멱등 기록표)
--    "이 접수(order_receipt_id)의 이 파일(file_index)에서 이 종류(type)의 주문을 만들었다"를 1행으로 기록.
--    UNIQUE(order_receipt_id, file_index, type)로 재승인/중복클릭 시 중복 생성을 DB 레벨에서 차단.
CREATE TABLE IF NOT EXISTS `order_receipt_generated_order` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `order_receipt_id` INT NOT NULL COMMENT 'FK) order_receipt.id, 자동주문을 유발한 접수 id',
  `file_index` INT NOT NULL COMMENT 'filePath(콤마구분) 내 파일 순번 (0부터)',
  `order_id` INT NOT NULL COMMENT 'FK) order.id, 이 파일에서 생성된 임시(TEMP) 주문 id',
  `type` VARCHAR(20) NOT NULL COMMENT '생성된 주문 종류 ex) GENERAL, SSG',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_receipt_file_type` (`order_receipt_id`, `file_index`, `type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='주문접수 자동주문 멱등 기록표';

-- 2) order_receipt_auto_result (검산 리포트 스냅샷)
--    승인(COMMIT) 시점 리포트를 통째로 JSON 직렬화해 1행 저장. 재조회/재승인 시 재계산 없이 반환.
--    접수당 1건(order_receipt_id UNIQUE).
CREATE TABLE IF NOT EXISTS `order_receipt_auto_result` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `order_receipt_id` INT NOT NULL COMMENT 'FK) order_receipt.id, 접수당 리포트 1건',
  `result_json` LONGTEXT NOT NULL COMMENT '리포트 전체(파일/주문/blocked/reconciliation) JSON 직렬화 스냅샷',
  `generated_at` DATETIME NOT NULL COMMENT '리포트 생성(=승인 커밋) 시각',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_order_receipt_id` (`order_receipt_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='주문접수 자동주문 검산 리포트 스냅샷';
