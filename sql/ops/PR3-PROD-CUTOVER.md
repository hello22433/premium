# PR3 (WALLET_PR3_SETTLE_MODE=wallet) PROD Cutover 실행 런북

작성: 2026-07-07. 근거: dev PR3 cutover 리허설(2026-07-07) 확정 절차 + 기존 prod 자료.

## ⚠️ 대원칙

- **prod 실데이터. dev reconcile 값 절대 재사용 금지** — 모든 reconcile 타깃은 prod 에서 새로 진단한다.
- **freeze + 백업 없이는 실행 금지.** dev 에서 freeze 미유지로 값이 계속 움직여 재작업했다.
- deposit COMPANY 모드 phantom 케이스는 **company.balance 실측을 운영/직원 확인**(ops_20260630 §직원확인 선례) 후 타깃 확정.
- reconcile 은 전부 **ledger INSERT-먼저 → 검증 → UPDATE**, auto-commit OFF + stop-on-error ON, 검증 통과 시에만 COMMIT.

## dev 리허설 확정 사실 (prod 에 그대로 적용)

1. **credit 불변식 = `wallet.credit_used (+credit_excess) == Σ user.all_settle_amount`** (per settlement_code & 전역). allocation 은 더하지 않는다(이미 all_settle 에 미러됨 — order.service.ts:4199). → 기존 cutover_gate P1-a credit_used 체크가 맞다.
2. **deposit 불변식 = `wallet.deposit_balance == effectiveBalance`** (COMPANY: company.balance / ACCOUNT: Σuser.balance). COMPANY 모드 user.balance 는 phantom → naive P1-a/P1-b 는 phantom 만큼 오탐. §E 로 phantom 정리하면 naive 도 수렴.
3. **settle_method**: `wallet.settle_method == company.settle_method`(단일값). mismatch 면 flip 시 카드할증 정책이 뒤집힘 → 사전 sync 필수.
4. **최종 판정 = parity 게이트** (`ops_20260707_pr3_parity_gate.sql`): `wallet_remain == legacy_remain` 전 계정 0행. naive 게이트가 mixed-mode 에서 오탐/누락해도 이게 진실.

## 전제 확인 (prod 현재 상태)

- [ ] `WALLET_PR2_DELIVERY_LIFECYCLE_MODE=wallet` 이미 운영 중인지 (PR3 전제). RUNBOOK §11.2 순서상 PR2→PR3 은 1~2일 간격.
- [ ] 기존 prod reconcile 적용 여부 확인:
  - `ops_20260630_pr3_wallet_reconcile.sql` (company-2/13/40 deposit, company-15 credit_used, company-4 credit_limit)
  - `ops_20260706_pr3_deposit_reconcile_3co.sql`, `ops_20260706_pr3_company2_deposit_reconcile.sql`
  - → 적용됐으면 그만큼 drift 이미 해소. parity 게이트로 잔여분만 재판정.

## 실행 순서

### 0. 준비
- [ ] 배포: 현재 develop(레거시 예치금 sync `syncDeposit` + external all_settle 컬럼 fix 포함) prod 반영 + `pm2 restart`(reload 금지).
- [ ] 점검창 공지 + **write FREEZE** (충전/주문/정산/CS/재발송/외부API/관련 cron 중단).
- [ ] **DB 백업**.

### 1. 현황 진단 (READ-ONLY, freeze 하)
- [ ] `ops_20260706_pr3_cutover_gate.sql` 실행 → P0/P2*/P3 PASS 확인. P1-a credit_used / P1-a deposit / P1-b 는 아래 개별 판정.
- [ ] `ops_20260707_pr3_parity_gate.sql` 실행 → **어긋난 settlement_code 목록 확보** (diff 부호로 원인 방향 판단).
- [ ] P3 settle_method mismatch 있으면 detail 로 계정 특정.

### 2. Reconcile (parity 게이트가 0행 될 때까지, prod 진단값으로)
어긋난 계정별로:
- [ ] **credit_used ≠ Σall_settle** → `wallet.credit_used = Σall_settle` 로 보정 (ledger BALANCE_MODIFY/CREDIT). 참고: `ops_20260707_pr3_dev_credit_used_reconcile.sql` 구조.
- [ ] **deposit ≠ effectiveBalance** → COMPANY 모드는 `= company.balance`(직원확인 실측), ACCOUNT 은 `= user.balance` (ledger BALANCE_MODIFY/DEPOSIT). 참고: `ops_20260630_pr3_wallet_reconcile.sql` / `ops_20260707_pr3_dev_deposit_reconcile.sql`.
- [ ] **settle_method mismatch** → `wallet.settle_method = company.settle_method` (단순 UPDATE, ledger 불필요).
- [ ] (선택) COMPANY 모드 phantom user.balance §E 정리 → naive 게이트까지 clean.
- [ ] 각 reconcile: SECTION B 사전검증 → INSERT → 원장 확인 → UPDATE → D 검증 → COMMIT.

### 3. 최종 GO 판정 (freeze 유지)
- [ ] `ops_20260707_pr3_parity_gate.sql` → **0 rows** 확인 (= GO). 아니면 2 로 복귀.
- [ ] `ops_20260706_pr3_cutover_gate.sql` → P0/P2*/P3 PASS, credit_used PASS(=Σall_settle 일치), deposit 은 §E 안 했으면 phantom CHECK 무해(parity 0 이면 OK).

### 4. Flip
- [ ] `.env`: `WALLET_PR3_SETTLE_MODE=wallet`
- [ ] `pm2 restart backend` (**reload 금지** — stale claim 중복발송 방지, README §배포주의).
- [ ] 부팅 로그: `Nest application successfully started` + `activation gate: PR2 mode=WALLET, PR3+PR4 hook services present` 확인. fail-closed throw 없는지.

### 5. Flip 직후 검증
- [ ] `ops_20260707_pr3_parity_gate.sql` 재실행 → **여전히 0 rows** (회귀 없음).
- [ ] 스모크: 대표 계정(대형 + COMPANY + ACCOUNT) 잔여한도 조회가 flip 전과 동일.
- [ ] 카드할증(settle_method 보정 계정) 정책 동일 확인.
- [ ] `wallet_shadow_remain_failed` / wallet 미존재 throw 로그 없는지.

### 6. 완료
- [ ] **freeze 해제**. 1~2주 안정화 모니터링 후 PR4 진행 / flag 제거.

## Rollback
- flip 후 문제 시: `.env` `WALLET_PR3_SETTLE_MODE=shadow`(또는 legacy) → `pm2 restart`. 조회 SoT 가 legacy 로 즉시 복귀(읽기 전용 전환이라 데이터 되돌릴 것 없음). reconcile 로 바꾼 wallet 값은 legacy 와 일치시킨 것이라 유지해도 무해.
