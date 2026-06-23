-- SSG PIN INSERT 시도 로컬 블랙리스트 테이블
-- SSG Oracle DB에 unique 제약이 없어 중복 INSERT 방지를 위해 로컬에서도 추적
CREATE TABLE IF NOT EXISTS ssg_issue_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bar_code VARCHAR(32) NOT NULL COMMENT 'SSG INSERT 시도한 barCode',
  personal_code VARCHAR(32) NOT NULL COMMENT 'SSG INSERT 시도한 personalCode',
  order_delivery_id INT NOT NULL COMMENT 'FK) order_delivery.id',
  ssg_transaction_id VARCHAR(64) NOT NULL COMMENT 'SSG trId',
  event_no VARCHAR(32) NOT NULL COMMENT 'SSG 이벤트 번호',
  inserted_at DATETIME(6) NOT NULL COMMENT 'SSG INSERT 시도 시각',

  INDEX idx_ssg_issue_log_bar_code (bar_code),
  INDEX idx_ssg_issue_log_personal_code (personal_code)
) COMMENT = 'SSG PIN INSERT 시도 블랙리스트 (중복 방지용)';
