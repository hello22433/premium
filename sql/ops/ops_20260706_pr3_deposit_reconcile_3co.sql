-- =============================================================================
-- PR3 전환 선행 — 레거시 예치금 wallet drift 백로그 reconcile (company-2/13/40)
-- 일자: 2026-07-06 (rev.3 — fail-closed + implicit-commit 분리)
-- 성격: 데이터 변경(3행 UPDATE + audit 3행). freeze 하 실행. fail-closed(SIGNAL) 가드.
-- 근거:
--   레거시 주문 예치금 환불이 legacy 만 갱신하고 wallet.deposit_balance 를 미동기했던 코드 갭
--   (이번 PR 의 syncDeposit 으로 수정)의 누적분. 진단(2026-07-06, vs company.balance 기준):
--     company-2 -100,000 / company-13 -99,000 / company-40 -95,000 (전부 wallet<legacy).
-- baseline = backfill 불변식 (20260521_backfill.sql:133 ON DUPLICATE KEY UPDATE):
--     wallet.deposit_balance = IFNULL(company.balance,0) + IFNULL(Σ user.balance(company),0)
--   컷오버 게이트(ops_20260706_pr3_cutover_gate.sql P1-a/P1-b) 정의와 통일.
-- ⚠️ 실행 전제: (1) 코드 fix(syncDeposit) 배포 완료 → (2) 전체 write FREEZE → (3) DB 백업.
--
-- ★ implicit-commit 주의 (MySQL): CREATE/DROP PROCEDURE 등 DDL 은 암묵 commit 을 유발한다.
--   그래서 가드 프로시저 생성/호출/삭제와 snapshot 캡처는 **START TRANSACTION 이전**에 모두 끝낸다.
--   트랜잭션 블록에는 UPDATE/INSERT/verify + 명시적 COMMIT/ROLLBACK 만 둔다(후행 DDL 금지) →
--   operator 의 COMMIT/ROLLBACK 결정 전에 쓰기가 암묵 commit 되지 않는다.
--   임시테이블은 세션 종료 시 자동 소멸하므로 트랜잭션 이후 DROP 하지 않는다.
-- fail-closed: 대상 3사 미충족 / 비-COMPANY / delta 범위 이탈 시 SIGNAL 로 (쓰기 전) 중단.
-- =============================================================================

-- ===== [STEP A] START TRANSACTION 이전 — 가드/스냅샷 (DDL 암묵 commit 안전 구간) =====

-- A1) 가드 프로시저 정의 (DDL)
DELIMITER //
DROP PROCEDURE IF EXISTS _pr3_recon_guard //
CREATE PROCEDURE _pr3_recon_guard()
BEGIN
  IF (SELECT COUNT(*) FROM _pr3_recon_3co) <> 3 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ABORT: 대상 회사 수 != 3 (row 누락/settlement_code 불일치)';
  END IF;
  IF EXISTS (SELECT 1 FROM _pr3_recon_3co WHERE mode <> 'COMPANY') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ABORT: 비-COMPANY 모드 대상 포함 (baseline 정의 불일치)';
  END IF;
  IF EXISTS (SELECT 1 FROM _pr3_recon_3co WHERE delta IS NULL OR delta <= 0 OR delta > 10000000) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'ABORT: delta 범위 이탈 (기대: 0<delta<=10,000,000 wallet-short). 이미 보정/역방향/이상치';
  END IF;
END //
DELIMITER ;

-- A2) 고정 snapshot 캡처 (freeze 하 안정. baseline=backfill 불변식)
DROP TEMPORARY TABLE IF EXISTS _pr3_recon_3co;
CREATE TEMPORARY TABLE _pr3_recon_3co AS
SELECT w.id                              AS wallet_id,
       w.owner_id                        AS settlement_code,
       uc.id                             AS company_id,
       uc.balance_management_type        AS mode,
       w.deposit_balance                 AS wallet_deposit,
       (IFNULL(uc.balance, 0)
         + IFNULL((SELECT SUM(u.balance) FROM `user` u WHERE u.company_id = uc.id), 0)) AS target_deposit,
       (IFNULL(uc.balance, 0)
         + IFNULL((SELECT SUM(u.balance) FROM `user` u WHERE u.company_id = uc.id), 0))
         - w.deposit_balance             AS delta
  FROM wallet_account w
  JOIN user_company uc ON uc.id = CAST(SUBSTRING_INDEX(w.owner_id, '-', -1) AS UNSIGNED)
 WHERE w.owner_type = 'SETTLEMENT_CODE'
   AND w.owner_id IN ('company-2', 'company-13', 'company-40');

-- A3) 검토용 snapshot 출력
SELECT 'SNAPSHOT' AS chk, settlement_code, company_id, mode, wallet_deposit, target_deposit, delta
  FROM _pr3_recon_3co
 ORDER BY settlement_code;

-- A4) fail-closed 가드 (미충족 시 여기서 SIGNAL → 아래 트랜잭션 미진입)
CALL _pr3_recon_guard();

-- A5) 가드 프로시저 정리 (DDL — 여기서 삭제해 트랜잭션 이후 DDL 을 남기지 않는다. 암묵 commit 무해: 트랜잭션 미개시)
DROP PROCEDURE IF EXISTS _pr3_recon_guard;

-- ===== [STEP B] 트랜잭션 — 쓰기 + 검증 + 명시적 결정 (내부/후행 DDL 없음) =====
START TRANSACTION;

UPDATE wallet_account w
  JOIN _pr3_recon_3co r ON r.wallet_id = w.id
   SET w.deposit_balance = r.target_deposit;

INSERT INTO wallet_transaction
  (wallet_account_id, order_id, order_delivery_id, type, resource_type, amount, balance_after, memo, idempotency_key, created_at)
SELECT r.wallet_id, NULL, NULL, 'BALANCE_MODIFY', 'DEPOSIT', r.delta, r.target_deposit,
       'PR3 reconcile: deposit→backfill 불변식(company.balance + Σuser.balance)',
       CONCAT('reconcile:pr3:20260706:', r.settlement_code, ':deposit'), NOW(6)
  FROM _pr3_recon_3co r;

-- 사후검증(COMMIT 전): drift=0 (3건)
SELECT 'D-verify' AS chk, r.settlement_code,
       w.deposit_balance AS wallet_deposit, r.target_deposit,
       w.deposit_balance - r.target_deposit AS drift
  FROM _pr3_recon_3co r
  JOIN wallet_account w ON w.id = r.wallet_id
 ORDER BY r.settlement_code;
-- expect: drift=0 (3건)

-- ↓↓↓ D-verify drift=0 확인 후 아래 중 하나만 실행(트랜잭션의 마지막 문장; 뒤에 DDL 없음) ↓↓↓
-- COMMIT;
-- ROLLBACK;

-- ===== [STEP C] (선택) 임시테이블 정리 — COMMIT/ROLLBACK 확정 후 별도로 실행 =====
-- 임시테이블은 세션 종료 시 자동 소멸하므로 생략 가능. 즉시 정리하려면 위 결정 실행 후 아래를 실행:
-- DROP TEMPORARY TABLE IF EXISTS _pr3_recon_3co;

-- 이후: ops_20260706_pr3_cutover_gate.sql 재실행(전 게이트 PASS) + 재축적 drift=0(24h 관측).
-- flip 은 #6/#7 정산조정 wallet-routing + #8 레거시 차감 동기화 선행돼야 함(별도 PR).
