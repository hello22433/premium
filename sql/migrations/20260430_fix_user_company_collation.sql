-- user_company 테이블 collation을 DB 기본(utf8mb4_0900_ai_ci)으로 통일
-- 배경: user_company만 utf8mb4_unicode_ci였고, 다른 테이블(user, order 등)은 utf8mb4_0900_ai_ci.
--        order.snapshot_* + user_company.business_* 가 함께 LIKE/COALESCE 되는
--        검색 쿼리에서 "Illegal mix of collations" 에러 발생.
-- 적용: 운영 DB는 별도 ALTER 실행 완료. 본 파일은 신규/dev 환경 정합성 보장용.
ALTER TABLE user_company
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
