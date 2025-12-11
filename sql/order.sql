ALTER TABLE epopkon.`order` ADD encourage_day int NULL COMMENT '독려 문자 day';

ALTER TABLE epopkon.`order` ADD test_delivery_count int NULL COMMENT '테스트 알림 횟수' AFTER encourage_day;

ALTER TABLE epopkon.order_delivery ADD encourage_at datetime NULL COMMENT '독려 문자 일시';

ALTER TABLE `order`
    ADD COLUMN settle_status ENUM('UNSETTLE_OVERDUE', 'UNSETTLE_NORMAL', 'SETTLE_COMPLETE') NULL COMMENT '정산상태';

ALTER TABLE `order`
    ADD COLUMN is_settle_complete TINYINT(1) DEFAULT 0 COMMENT '정산 확정 여부';

ALTER TABLE `order`
    ADD COLUMN is_settle_balance TINYINT(1) DEFAULT 0 COMMENT '정산 선충전 혹은 한도 여부';

-- =========================================
-- order 테이블 컬럼 삭제 (order_product_mapping으로 이동)
-- 실행 전 order_product_mapping에 데이터 마이그레이션 완료 확인 필요
-- =========================================

-- 발송 제목/내용 컬럼 삭제
ALTER TABLE `order` DROP COLUMN send_title;
ALTER TABLE `order` DROP COLUMN send_content;

-- 독려 문자 day 컬럼 삭제
ALTER TABLE `order` DROP COLUMN encourage_day;

-- 발송 방법 관련 컬럼 삭제
ALTER TABLE `order` DROP COLUMN send_method;
ALTER TABLE `order` DROP COLUMN send_tail_text;

-- 개인정보 파기 요청일 컬럼 삭제
ALTER TABLE `order` DROP COLUMN request_to_destroy_personal_info_day;

-- 발신번호/이메일 관련 컬럼 삭제
ALTER TABLE `order` DROP COLUMN from_phone_number;
ALTER TABLE `order` DROP COLUMN from_email;
ALTER TABLE `order` DROP COLUMN email_send_type;
ALTER TABLE `order` DROP COLUMN use_email_content;

-- 발송 요청일시/타입 컬럼 삭제
ALTER TABLE `order` DROP COLUMN send_request_at;
ALTER TABLE `order` DROP COLUMN send_type;

-- 테스트발송횟수 삭제
ALTER TABLE `order`
    DROP COLUMN test_delivery_count;

ALTER TABLE `order`
    ADD COLUMN `delivery_report_last_source` VARCHAR(20) NULL COMMENT '마지막 배송 완료 리포트 발행 소스 ex) DOCUMENT: 문서함, DIRECT: 직접발행',
    ADD COLUMN `transaction_statement_last_source` VARCHAR(20) NULL COMMENT '마지막 거래명세서 발행 소스 ex) DOCUMENT: 문서함, DIRECT: 직접발행';
