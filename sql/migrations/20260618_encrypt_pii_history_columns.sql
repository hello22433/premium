-- 이력/로그 테이블 PII 평문 저장 제거 — 컬럼 폭 확장 (암호문 저장 대비)
-- 배경: delivery_send_history.target, email_send_history.email 에 복호화된 수신처/이메일/전화번호가
--       평문으로 저장되던 경로를 암호화 저장(encryptDeliveryTarget, AES-256-CBC/Base64)으로 전환.
--       암호문은 평문보다 길어지므로(긴 이메일 기준 base64 ≈ 1.37x + PKCS#7 패딩) 컬럼 폭을 확장한다.
--
-- 적용 범위:
--   - delivery_send_history.target : VARCHAR(128) -> VARCHAR(255)
--   - email_send_history.email     : VARCHAR(200) -> VARCHAR(512)
--   (user_task_history.content 는 TEXT, activity_log.requestParams 는 JSON 이라 폭 변경 불필요)
--
-- 백필 방침: 신규 쓰기만 암호화. 기존 평문 행은 그대로 두고, 읽기 시 safeDecryptDeliveryTarget 로 평문 폴백.
--           (target/email 컬럼은 앱 내 조회키/표시 reader 가 없어 백필 없이 안전. user_task_history.content
--            는 getDetail 읽기에서 safeDecrypt 폴백으로 기존 평문 행이 그대로 노출됨.)
--
-- 적용 환경: MySQL 8.x. ALTER 는 메타데이터/online 변경.
-- 적용 절차: sql/RUNBOOK.md (staging dry-run -> RDS 스냅샷 -> prod 적용).

ALTER TABLE delivery_send_history
  MODIFY COLUMN target VARCHAR(255) NOT NULL COMMENT '전송 대상자 (암호화 저장, encryptDeliveryTarget)';

ALTER TABLE email_send_history
  MODIFY COLUMN email VARCHAR(512) NOT NULL COMMENT '이메일/식별값 (암호화 저장, encryptDeliveryTarget)';

-- 검증
--   SHOW COLUMNS FROM delivery_send_history LIKE 'target';
--   SHOW COLUMNS FROM email_send_history LIKE 'email';
--
-- 롤백 (암호문이 평문보다 길어 폭을 줄이면 잘릴 수 있으므로 롤백 전 데이터 확인 필수)
--   ALTER TABLE delivery_send_history MODIFY COLUMN target VARCHAR(128) NOT NULL COMMENT '전송 대상자';
--   ALTER TABLE email_send_history MODIFY COLUMN email VARCHAR(200) NOT NULL COMMENT '이메일';
