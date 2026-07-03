-- coupon-view 페이지 방문 로그 테이블
-- 카카오 알림톡 '선물 확인하기' 링크(coupon-view/{encryptKey}) 진입 시 브라우저 JS가 호출하는
-- GET /order/receive/alim-talk 1건 = 실제 페이지 열람 1회. 방문마다 1행 append(모든 방문 기록).
-- 고객이 '페이지를 못 봤다'며 보상을 요구할 때 실제 방문 여부/시각 판별 증거로 사용한다.
-- 실행 시점: 코드 배포 전 (신규 테이블, 기존 데이터 영향 없음)

CREATE TABLE IF NOT EXISTS `coupon_view_log` (
  `id`                INT          NOT NULL AUTO_INCREMENT,
  `order_delivery_id` INT          NOT NULL COMMENT 'FK) order_delivery.id',
  `ip_address`        VARCHAR(45)  NULL     COMMENT '방문자 IP (x-forwarded-for 우선, IPv4/IPv6)',
  `user_agent`        VARCHAR(512) NULL     COMMENT 'User-Agent 원문',
  `referer`           VARCHAR(512) NULL     COMMENT 'Referer 헤더',
  `source`            VARCHAR(20)  NOT NULL COMMENT '진입 경로 (alimtalk: 알림톡)',
  `dedup_key`         VARCHAR(120) NOT NULL COMMENT 'dedup 키 "{orderDeliveryId}:{ip}:{10초버킷}" — 동시요청 중복방문 원자적 차단',
  `is_bot`            TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '알려진 크롤러/미리보기 봇 UA 여부 (1=봇, 실제 방문 아님)',
  `created_at`        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '방문 시각',
  `updated_at`        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`        DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_coupon_view_log_dedup` (`dedup_key`),
  KEY `idx_coupon_view_log_delivery_created` (`order_delivery_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='coupon-view 페이지 방문 로그';
