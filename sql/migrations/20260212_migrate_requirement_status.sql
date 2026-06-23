-- 개발지원요청 상태값 변경 마이그레이션
-- REVIEW → REVIEW_COMPLETE, COMPLETE → DEV_COMPLETE

UPDATE requirement SET status = 'REVIEW_COMPLETE' WHERE status = 'REVIEW';
UPDATE requirement SET status = 'DEV_COMPLETE' WHERE status = 'COMPLETE';
