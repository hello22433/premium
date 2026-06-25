# Wallet PR1a — Backfill RUNBOOK

PR1a 마이그레이션 + backfill 운영 절차. consensus plan v4 §Acceptance Criteria + Pre-mortem Scenario 1/3 대응.

---

## 1. 배경

PR1은 schema + entity + service skeleton PR. 신규 테이블 10개 + `user.settlement_code` 컬럼 + legacy 컬럼 deprecated 주석 + wallet service skeleton (WalletLedgerService / PaymentAllocationService / RefundPoolService / OrderConfirmationWalletService / SettleConfirmationWalletService / CreditExcessApprovalService) + backfill SQL.
service skeleton 은 존재하나 **호출자(order/settle/delivery/cs/external_api hook) 0건 = 신 wallet 쓰기 0건 보장** (드리프트 방지). PR2~PR5 에서 hook + cutover 진행.
backfill 은 `ON DUPLICATE KEY UPDATE` 로 idempotent (재실행 시 drift 갱신).

핵심 invariant:

- legacy `Σ user.balance + Σ user_company.balance` == `Σ wallet_account.deposit_balance`
- legacy `Σ user_company.maximumLimit` == `Σ wallet_account.credit_limit`
- `Σ wallet_account.credit_used_amount` == `Σ user.allSettleAmount` (backfill 시점 snapshot, PR2 발송확정에서 누적 갱신)
- `Σ wallet_account.credit_excess_amount` == 0
- `wallet_account (owner_type, owner_id)` 중복 0건

---

## 2. 마이그레이션 순서

```
1. 20260521_alter_user_add_settlement_code.sql
2. 20260521_create_wallet_tables.sql
3. 20260521_create_point_tables.sql
4. 20260521_create_order_payment_allocation.sql
5. 20260521_create_order_payment_refund_event.sql
6. 20260521_create_order_delivery_attempt.sql
7. 20260521_create_credit_excess_approval.sql
8. 20260521_seed_point_policy_ssg_deny.sql    ← SSG 공통 DENY 정책 seed (PR2 발송확정에서 참조)
9. 20260521_backfill.sql                      ← 단일 트랜잭션, assertion 포함
```

9 외 1~8은 `CREATE TABLE` / seed INSERT 단일 실행. 9는 **반드시 dry-run 후 prod 적용**.

---

## 3. Dry-run 절차 (staging)

```sql
-- 9번 backfill 파일 본문을 그대로 실행하되 마지막 COMMIT 를 ROLLBACK 으로 바꾼다.
BEGIN;
-- ... 1, 2 단계 (UPDATE + INSERT)
-- ... 3 단계 검증 쿼리 4종 + 중복 검증
-- 결과를 운영 채널에 출력 후
ROLLBACK;
```

검증 쿼리 4종 + 중복 검증을 모두 만족하면 prod 적용. 1건이라도 불일치면 사유 분석 후 재계획.

---

## 4. Staging 모니터링 (1주)

PR1a 머지 후 staging 에서 **1주 모니터링**:

- `wallet_account` 신규 INSERT 0건 보장 (PR1a 는 schema-only).
- legacy `user.balance` / `user_company.balance` 변동 추적 (운영 정상 흐름).
- 1주 후에도 invariant SUM 차이 0 확인.

차이 발견 시 → PR2 머지 직전 `20260521_backfill.sql` 재실행 (idempotent `ON DUPLICATE KEY UPDATE` 갱신).

---

## 5. Prod 적용

- 점검 시간 + 백업 직후 적용.
- 9번 backfill 트랜잭션 실행.
- 검증 쿼리 4종 + 중복 0건 확인 후 COMMIT.
- 불일치 시 즉시 ROLLBACK + 알림.

---

## 6. PR1a → PR1b 머지 SLA

**48시간 이내** PR1b 머지 완료. 초과 시:

1. legacy `user.balance` / `user_company.balance` 변동 발생 → wallet_account 와 drift 발생 가능.
2. PR1b 머지 직전 `20260521_backfill.sql` **재실행 강제** (idempotent SQL이므로 안전).
3. 운영 채널 알림.

PR2 진입 시점에도 동일 — backfill 재실행 후 PR2 적용.

---

## 7. Rollback

PR1a 자체 rollback 필요 시:

- 신규 10 테이블 DROP (CREATE TABLE 8개에 대응).
- `user.settlement_code` 컬럼 DROP.
- entity 정의 + database.module 등록 revert.
- ESLint 규칙 revert.

legacy 컬럼은 손대지 않으므로 rollback 시 데이터 손실 없음.

---

## 8. 검증 명령 (PR1a 머지 후)

```bash
# 1. ESLint 규칙 동작 확인 (no-restricted-properties)
npm run lint

# 2. backfill SQL 구조 spec
npm test -- --runInBand src/wallet/__tests__/backfill.spec.ts

# 3. entity TypeORM 매핑 spec
npm test -- --runInBand src/wallet/__tests__/wallet.entity.spec.ts

# 4. settlement_group 잔존 검증 (0 hit 기대)
git grep -n 'settlement_group' src/

# 5. PR2 이전 신 wallet hook/caller 0건 검증 (0 hit 기대)
#    wallet service 는 src/wallet 안에만 존재해야 함. src/wallet 외부에서 wallet 서비스 import 시 신 wallet 쓰기 hook 진입.
git grep -nE "from .*wallet/application/(wallet-ledger|order-confirmation-wallet|settle-confirmation-wallet|refund-pool|credit-excess-approval|payment-allocation)" src/ | grep -v "^src/wallet/"
```

---

# Wallet Cutover Bundle (PR2+PR3+PR4) — RUNBOOK

PR1a 후속. Cutover Bundle 은 발송 생명주기(PR2) + 정산(PR3) + CS/재발송(PR4) 을 한 번에 prod 배포 + 단계적 wallet activation.

Plan 참조: `.omc/plans/wallet-cutover-bundle-consensus-plan.md` (v2.1 APPROVED)

## 9. Cutover Bundle 마이그레이션 순서

```
0. PR1a (위 1~9 단계) 사전 완료 + 1주 staging 모니터링 + invariant 4종 통과.
10. 20260523_alter_order_payment_allocation_add_released.sql    ← F-001
    - ADD COLUMN released_at DATETIME(6) NULL, release_reason VARCHAR(200) NULL
    - ALGORITHM=INPLACE, LOCK=NONE (MySQL 8.0.29+)
    - 사전 측정: SELECT VERSION(); SELECT COUNT(*) FROM order_payment_allocation;
    - 예상 duration < 5min @ 1M rows
```

10번은 schema-only DDL, backfill 불필요 (default NULL = "active wallet-managed", 신규 보상 시 채워짐).

## 10. PR2~PR4 prod 배포 + flag staging

PR2~PR4 코드는 **하나의 머지 윈도우** 에 prod 배포. 배포 직후 기본값:

```bash
WALLET_PR2_DELIVERY_LIFECYCLE_MODE=legacy
WALLET_PR3_SETTLE_MODE=legacy
WALLET_PR4_CS_RESEND_MODE=legacy
```

이 상태에서는 wallet write 0건. 기존 legacy path 그대로 동작. 배포 회귀 검증 (PR1 76 test + PR2/PR3/PR4 mini e2e + Bundle lifecycle e2e + deadlock spec 모두 staging 통과 확인 후 prod).

## 11. Activation gate (단계적 cutover)

### 11.1 Staging 검증

```
1. WALLET_PR{2,3,4}_*_MODE=shadow
   - deliveryConfirmed 동기 preview 비교 로그 활성화
   - wallet write 여전히 0건
   - wallet_cutover_shadow_mismatch_total{class=*} 카운터 관찰 (real_drift = 0 목표)

2. WALLET_PR2_DELIVERY_LIFECYCLE_MODE=wallet (staging only)
   - Startup gate: PR3/PR4 hook 코드 prod 배포 여부 검증 (DI 충족 → boot 성공)
   - 신규 발송확정 = wallet path + allocation 생성
   - 기존 발송 = legacy path 유지
   - mini e2e + Bundle lifecycle e2e 회귀

3. WALLET_PR3_SETTLE_MODE=wallet → WALLET_PR4_CS_RESEND_MODE=wallet 순차 전환
```

### 11.2 Prod 진입

Staging 1주 모니터링 + mismatch real_drift=0 확인 후:

```
1. prod WALLET_PR{2,3,4}_*_MODE=shadow (1~2일)
2. prod WALLET_PR2_DELIVERY_LIFECYCLE_MODE=wallet
3. prod WALLET_PR3_SETTLE_MODE=wallet
4. prod WALLET_PR4_CS_RESEND_MODE=wallet
5. 1~2주 안정화 후 flag 제거 PR (default wallet 하드코딩).
```

## 12. Manual recovery (Startup gate 실패 시)

PR2 mode=WALLET 인 상태에서 NestJS bootstrap 이 `wallet_cutover_activation_gate_blocked` 로 throw + process exit 1 발생 시:

1. **운영자 즉시 조치**:

   ```bash
   # 1.1 현재 ENV 확인
   echo "PR2=$WALLET_PR2_DELIVERY_LIFECYCLE_MODE PR3=$WALLET_PR3_SETTLE_MODE PR4=$WALLET_PR4_CS_RESEND_MODE"

   # 1.2 PR2 를 legacy 로 즉시 복귀 (PR3/PR4 hook 미배포 상태)
   #     systemd / docker / k8s deployment 설정 갱신
   export WALLET_PR2_DELIVERY_LIFECYCLE_MODE=legacy

   # 1.3 service 재시작 (bootstrap 통과 확인)
   ```

2. **PagerDuty 알림** (`WALLET_CUTOVER_PD_SERVICE_KEY`, severity=critical):
   - "Activation gate blocked: PR{N} hook DI missing"
   - Wallet Squad on-call 즉시 응답.

3. **근본 원인 분석**:
   - PR3 또는 PR4 hook 코드 prod 배포 누락 (CI/CD 실패) → 재배포.
   - DI provider 등록 누락 (app.module.ts) → 코드 fix → 재배포.
   - **자동 fallback 절대 도입 안 함** — fail-closed 원칙 (옵션 C 금지).

4. **복구 후 재진입**:
   - PR3+PR4 hook DI 충족 확인.
   - Startup gate 재통과 후 PR2 mode=wallet 재시도 (위 11 단계).

## 13. Flag rollback (`wallet` → `legacy`) 정책

PR2 mode=wallet 운영 중 critical drift 또는 incident 발생 시:

1. **즉시 조치**:

   ```bash
   export WALLET_PR2_DELIVERY_LIFECYCLE_MODE=legacy
   # service rolling restart
   ```

2. **결과**:
   - 신규 주문은 legacy path (wallet write 없음).
   - **기존 wallet-managed 주문 (allocation 존재 + released_at IS NULL) 은 후속 hook 에서 여전히 wallet path 진입** (allocation routing > flag, Round 5 결정).
   - 따라서 PR3+PR4 hook 코드는 prod 에 계속 배포돼 있어야 함 (flag legacy 상태에서도).

3. **재진입 (`legacy` → `wallet`) 절차**:
   - PR1 backfill 합산식 (`user_company.balance + SUM(user.balance) → wallet_account.deposit_balance`) account-level reconciliation 재실행 (off 기간 legacy 변동분 sync).
   - 주문별 allocation 재구성 backfill 불필요 (off 기간 신규 주문은 끝까지 legacy).
   - Staging shadow 재확인 후 prod wallet 재전환.

## 14. F-001 migration 사전 검증

```bash
# 1. prod MySQL 버전 확인 (8.0.29+ 필수)
mysql -e "SELECT VERSION();"

# 2. row count + 예상 duration 측정
mysql -e "SELECT COUNT(*) FROM order_payment_allocation;"

# 3. staging dry-run
mysql staging_db < sql/20260523_alter_order_payment_allocation_add_released.sql
mysql staging_db -e "DESCRIBE order_payment_allocation;" | grep -E "released_at|release_reason"

# 4. 예상 INPLACE 가능 여부 확인
mysql -e "SELECT * FROM INFORMATION_SCHEMA.INNODB_METRICS WHERE NAME LIKE '%ddl%';"
```

## 15. `package.json` test:e2e 경로 사전 검증

PR2 mini e2e 실행 전 `package.json` 의 `test:e2e` script 경로 확인:

```bash
cat package.json | grep test:e2e
# 기대: "jest --config ./test/jest-e2e.json"
# 실측 오타 가능성: "jest --config ./test/jest-e2 e.json" (공백 포함)
# 오타 발견 시 별도 chore PR 로 분리 수정 (본 Bundle 범위 밖)
```
