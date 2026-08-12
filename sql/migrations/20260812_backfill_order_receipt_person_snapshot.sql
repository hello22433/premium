-- 주문접수 기존 행 표시값 스냅샷 백필
-- 실행 순서: 20260812_add_order_receipt_person_snapshot.sql -> 신규 애플리케이션 배포 -> 이 스크립트
--
-- snapshot_person_name 은 스냅샷 기록 완료 판별자다. business_name 은 회사 미배정 사용자에게 NULL 일 수 있다.
-- 기존 데이터가 아직 변경되지 않았다는 전제에서 현재 user/user_company 값을 동결한다.
-- ⚠️ 전제가 깨진 계정(배포 전에 이미 담당자명이 바뀐 계정)은 아래 [예외] 절에서 개별 정정한다.

UPDATE `order_receipt` AS r
INNER JOIN `user` AS u ON u.id = r.user_id
LEFT JOIN `user_company` AS uc ON uc.id = u.company_id
SET
  r.snapshot_person_name = u.person_name,
  r.snapshot_business_name = uc.business_name
WHERE r.snapshot_person_name IS NULL;

UPDATE `order_receipt` AS r
INNER JOIN `user` AS pu ON pu.id = r.processed_user_id
SET r.snapshot_processed_person_name = pu.person_name
WHERE r.processed_user_id IS NOT NULL
  AND r.snapshot_processed_person_name IS NULL;

-- 완료 조건: 0. 잔여 행은 user 관계가 없는 orphan 이므로 자동 완료로 취급하지 않는다.
SELECT COUNT(*) AS remaining_snapshot_person_name_null_count
FROM `order_receipt`
WHERE snapshot_person_name IS NULL;

-- 잔여 orphan 예외 목록 확인용. 0건이 아니면 감사자료로 복원하거나 승인된 예외 목록을 남긴다.
SELECT r.id, r.user_id, r.register_at, r.title
FROM `order_receipt` AS r
LEFT JOIN `user` AS u ON u.id = r.user_id
WHERE r.snapshot_person_name IS NULL
ORDER BY r.id;


-- ── [예외] user.id=38 ((주)밀텍산업) ──────────────────────────────────────
-- 이 계정은 2026-08-10 18:04:19 에 담당자명이 '윤혜진' → '강한나' 로 교체됐다.
--   근거: user.updated_at = 2026-08-10 18:04:19
--         밀텍산업 대행주문 18건(2026-03-10 ~ 2026-08-10 17:51)의
--         order.snapshot_client_person_name 이 전부 '윤혜진'
-- 접수 13건은 전부 2026-07-15 이전이라 당시 담당자는 윤혜진이다.
-- 위 일괄 백필이 현재 이름('강한나')으로 덮었으므로 교체 시각 이전 건을 되돌린다.
UPDATE `order_receipt`
SET snapshot_person_name = '윤혜진'
WHERE user_id = 38
  AND register_at < '2026-08-10 18:04:19'
  AND snapshot_person_name = '강한나';

-- 검증: 13건이 윤혜진, 그 이후 접수건이 있으면 강한나로 남아야 한다.
SELECT snapshot_person_name, COUNT(*) AS cnt, MIN(register_at) AS first_at, MAX(register_at) AS last_at
FROM `order_receipt`
WHERE user_id = 38
GROUP BY snapshot_person_name;
