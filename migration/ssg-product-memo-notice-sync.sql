-- SSG 안내문구 정본 일원화 백필
--
-- 배경
--   신세계 안내문구가 두 곳에 따로 있었다.
--     - 문자/이메일 MMS  : src/delivery/domain/sms.ssg.template.ts (코드 상수)
--     - 알림톡/이메일 쿠폰 페이지 : product.memo (DB)
--   코드만 개정되고 DB 는 그대로라 쿠폰 페이지가 구버전 문구를 계속 노출했다.
--   (구버전 차이: `▷교 환 처`, `가까운 신세계이마트`, `▷발송업체` 상단 배치,
--    `신세계 모바일교환권/상품권 유의사항` 링크가 유의사항 목록 밖에 있음)
--
-- 이 배포부터 문자도 product.memo 를 정본으로 읽는다(코드 상수는 memo 공백 시 폴백).
-- 따라서 이 스크립트로 SSG 상품 memo 를 최신 문구로 맞춰야 문자·쿠폰 페이지가 같은 문구를 낸다.
--
-- 대상: product.type = 'SSG' AND partner_company.type = 'SSG' (2026-08-12 기준 138행, memo 전부 동일)
-- 주의: 문자는 memo 의 "첫 문단(도입문장)" 뒤에 상품명/쿠폰번호/인증번호/교환기간을 끼워 넣는다.
--       도입문장 다음의 빈 줄을 없애지 말 것.
--
-- 실행 순서: 0 → 1 → 2 → 3 (2 실행 전 0 결과를 보관)

-- ─────────────────────────────────────────────────────────
-- 0) 사전 확인 + 롤백용 원본 백업
--
--    ⚠ 백업은 절대 덮어쓰지 않는다. 재실행 시 백업을 다시 만들면 이미 UPDATE 된 값이 "원본"으로
--    덮여써 롤백 수단이 사라진다. 그래서 CREATE TABLE IF NOT EXISTS + INSERT IGNORE 로,
--    최초 1회만 기록되고 이후 실행은 기존 행을 건드리지 않는다(새 권종 행만 추가된다).
-- ─────────────────────────────────────────────────────────
SELECT COUNT(*) AS target_cnt, COUNT(DISTINCT p.memo) AS distinct_memo_cnt
FROM product p
JOIN partner_company pc ON pc.id = p.partner_company_id
WHERE p.type = 'SSG' AND pc.type = 'SSG';

CREATE TABLE IF NOT EXISTS product_memo_backup_ssg_20260812 (
  id           INT      NOT NULL PRIMARY KEY,
  memo         TEXT     NULL,
  backed_up_at DATETIME NOT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 이미 백업된 id 는 건너뛴다(최초 원본 보존).
INSERT IGNORE INTO product_memo_backup_ssg_20260812 (id, memo, backed_up_at)
SELECT p.id, p.memo, NOW()
FROM product p
JOIN partner_company pc ON pc.id = p.partner_company_id
WHERE p.type = 'SSG' AND pc.type = 'SSG';

-- 백업 상태 확인. 재실행이라면 first_backup_at 이 최초 실행 시각 그대로여야 한다.
SELECT COUNT(*) AS backup_cnt, MIN(backed_up_at) AS first_backup_at, MAX(backed_up_at) AS last_backup_at
FROM product_memo_backup_ssg_20260812;

-- ─────────────────────────────────────────────────────────────
-- 1) 백필 (문구 정본 = sms.ssg.template.ts SSG_NOTICE_FALLBACK 과 동일)
-- ─────────────────────────────────────────────────────────────
UPDATE product p
JOIN partner_company pc ON pc.id = p.partner_company_id
SET p.memo = CONCAT(
  '본 교환권은 지류상품권으로 교환 후 사용할 수 있는 교환권입니다(SSG닷컴, SSG페이 사용불가)', CHAR(10),
  CHAR(10),
  '▷교환처: 전국 이마트 키오스크', CHAR(10),
  '▷가까운 이마트 위치 검색하기: https://www.epopkon.com/ssg/how2use', CHAR(10),
  CHAR(10),
  '▷교환방법: 고객센터에 비치된 키오스크에 쿠폰번호, 인증번호 입력', CHAR(10),
  '▷키오스크 이용방법: https://www.epopkon.com/ssg/kiosk', CHAR(10),
  CHAR(10),
  '▷유의사항', CHAR(10),
  '- 4만원 이하 권종은 1만원으로 분할하여 출력되니, 꼭 수량 확인 부탁드립니다.', CHAR(10),
  '- 교환처의 휴무일 사전 확인 후 유효기간내 교환부탁드립니다.', CHAR(10),
  '- 본 모바일 교환권은 이벤트 및 프로모션으로 무상으로 지급되어 유효기간 연장 환불이 불가능합니다.', CHAR(10),
  '- 본 모바일 교환권은 개인간 양도 및 매매를 할 수 없으며, 이로 인한 문제 발생시 당사는 책임지지 않습니다.', CHAR(10),
  '- 수집된 전화번호는 개인정보보호를 위해 발송일로부터 6개월간 보유되며, 보유기간 이후에는 복구 불가능하게 삭제되어 CS처리가 불가능합니다.', CHAR(10),
  '- 인당 1일 쿠폰번호 10개까지 사용가능 합니다.', CHAR(10),
  '- 신세계 모바일교환권/상품권 더 알아보기: https://www.epopkon.com/ssg/notice', CHAR(10),
  CHAR(10),
  '▷발송처: 모바일이앤엠애드', CHAR(10),
  '▷상품문의: 1644-3614 (내선 1번)', CHAR(10),
  '▷고객센터 운영시간: 평일 9시~18시', CHAR(10),
  '(점심시간 12시~13시 / 토, 일, 공휴일 휴무)'
)
WHERE p.type = 'SSG' AND pc.type = 'SSG';

-- ─────────────────────────────────────────────────────────────
-- 2) 검증 — 전 행이 같은 문구인지, 길이가 기대치인지
--    distinct_memo_cnt = 1 이어야 하고, 첫 문단 뒤 빈 줄이 살아 있어야 한다.
-- ─────────────────────────────────────────────────────────────
SELECT COUNT(*) AS updated_cnt,
       COUNT(DISTINCT p.memo) AS distinct_memo_cnt,
       MAX(CHAR_LENGTH(p.memo)) AS memo_char_len,
       MAX(LOCATE(CONCAT(CHAR(10), CHAR(10)), p.memo)) AS first_blank_line_pos
FROM product p
JOIN partner_company pc ON pc.id = p.partner_company_id
WHERE p.type = 'SSG' AND pc.type = 'SSG';

-- ─────────────────────────────────────────────────────────────
-- 3) 롤백 (필요 시에만)
-- ─────────────────────────────────────────────────────────────
-- UPDATE product p
-- JOIN product_memo_backup_ssg_20260812 b ON b.id = p.id
-- SET p.memo = b.memo;
