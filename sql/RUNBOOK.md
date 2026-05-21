# Wallet PR1a — Backfill RUNBOOK

PR1a 마이그레이션 + backfill 운영 절차. consensus plan v4 §Acceptance Criteria + Pre-mortem Scenario 1/3 대응.

---

## 1. 배경

PR1a는 schema-only PR. 신규 테이블 10개 + `user.settlement_code` 컬럼 + legacy 컬럼 deprecated 주석. **WalletLedgerService 없음 = 신 wallet 쓰기 0건 보장** (드리프트 방지).

핵심 invariant:
- legacy `Σ user.balance + Σ user_company.balance` == `Σ wallet_account.deposit_balance`
- legacy `Σ user_company.maximumLimit` == `Σ wallet_account.credit_limit`
- `Σ wallet_account.credit_used_amount` == 0 (PR2 발송확정에서 누적 시작)
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
8. 20260521_backfill.sql            ← 단일 트랜잭션, assertion 포함
```

8 외 1~7은 `CREATE TABLE` 만이므로 단일 실행. 8은 **반드시 dry-run 후 prod 적용**.

---

## 3. Dry-run 절차 (staging)

```sql
-- 8번 파일 본문을 그대로 실행하되 마지막 COMMIT 를 ROLLBACK 으로 바꾼다.
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

차이 발견 시 → PR1b/PR2 머지 직전 `20260521_backfill.sql` 재실행 (idempotent NOT EXISTS 가드로 안전).

---

## 5. Prod 적용

- 점검 시간 + 백업 직후 적용.
- 8번 backfill 트랜잭션 실행.
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

# 5. PR1b 이전 신 wallet 쓰기 검증 (0 hit 기대)
git grep -n 'wallet_account' src/ | grep -v 'entity/wallet'
```
