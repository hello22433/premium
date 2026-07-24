-- user.settlement_code 인덱스 추가.
-- 정산코드 검색(assignedUserCount 상관 서브쿼리)·상세(getSettlementCodeDetail) 모두
-- `WHERE settlement_code = ?` 로 user 를 조회하는데 인덱스가 없어, 검색 결과 행마다(최대 201건)
-- user 풀스캔이 발생한다. 유저 수 증가에 선형으로 무거워지므로 인덱스로 상수화한다.
-- 스펙: plans/2026-07-20-settlement-code-list-enhancement.md §3.2 (P2), 리뷰 wip6.

CREATE INDEX `idx_user_settlement_code` ON `user` (`settlement_code`);
