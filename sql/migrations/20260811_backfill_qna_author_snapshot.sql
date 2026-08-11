-- EP_P25 Task C: 기존 QnA 작성자 표시값 스냅샷 백필
-- 실행 순서: 20260811_add_qna_author_snapshot.sql -> 신규 애플리케이션 배포 -> 이 스크립트
-- person_name은 스냅샷 기록 완료 판별자다. business_name은 회사 미배정 사용자에게 NULL일 수 있다.
-- 기존 데이터가 아직 변경되지 않았다는 전제에서 현재 user/user_company 값을 동결한다.

UPDATE `qna` AS q
INNER JOIN `user` AS u ON u.id = q.user_id
LEFT JOIN `user_company` AS uc ON uc.id = u.company_id
SET
  q.snapshot_person_name = u.person_name,
  q.snapshot_business_name = uc.business_name
WHERE q.snapshot_person_name IS NULL;

-- 완료 조건: 0. 잔여 행은 user 관계가 없는 orphan이므로 자동 완료로 취급하지 않는다.
SELECT COUNT(*) AS remaining_snapshot_person_name_null_count
FROM `qna`
WHERE snapshot_person_name IS NULL;

-- 잔여 orphan 예외 목록 확인용. 0건이 아니면 감사자료로 복원하거나 승인된 예외 목록을 남긴다.
SELECT q.id, q.user_id, q.register_date, q.title
FROM `qna` AS q
LEFT JOIN `user` AS u ON u.id = q.user_id
WHERE q.snapshot_person_name IS NULL
ORDER BY q.id;
