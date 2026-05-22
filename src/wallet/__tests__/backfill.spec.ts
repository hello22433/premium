import * as fs from 'fs';
import * as path from 'path';

/**
 * PR1a backfill SQL 구조 검증 (consensus plan v4 §Step 5).
 * 실제 DB round-trip은 staging dry-run (RUNBOOK.md) 단계에서 수행.
 * 이 spec은 backfill SQL이 invariant를 만족하는지 정적 검증한다:
 *  - 단일 트랜잭션 (BEGIN/COMMIT)
 *  - settlement_code 일관 부여 (company-{id})
 *  - wallet_account INSERT 멱등 가드 (NOT EXISTS)
 *  - 4종 검증 쿼리 (deposit equality / credit_limit equality / credit_used wallet=0 / credit_excess wallet=0)
 *  - settlement_code 중복 검증 (GROUP BY HAVING COUNT > 1)
 *  - balanceManagementType 분기 없음 (모든 user 동일 처리)
 */
describe('PR1a backfill SQL — 구조 검증', () => {
  const sqlPath = path.resolve(__dirname, '../../../sql/20260521_backfill.sql');
  let sql: string;

  beforeAll(() => {
    sql = fs.readFileSync(sqlPath, 'utf8');
  });

  it('단일 트랜잭션으로 감싸져 있다', () => {
    const beginCount = (sql.match(/\bBEGIN\b/gi) ?? []).length;
    const commitCount = (sql.match(/\bCOMMIT\b/gi) ?? []).length;
    expect(beginCount).toBe(1);
    expect(commitCount).toBe(1);
  });

  it('모든 user에 settlement_code = company-{companyId} 부여 UPDATE 가 있다', () => {
    expect(sql).toMatch(/UPDATE\s+`?user`?\s+u/i);
    expect(sql).toMatch(/CONCAT\('company-',\s*c\.id\)/);
    expect(sql).toMatch(/u\.settlement_code\s*=\s*''/);
  });

  it('wallet_account INSERT 가 ON DUPLICATE KEY UPDATE 로 멱등성 + 재실행 갱신 보장한다', () => {
    expect(sql).toMatch(/INSERT INTO\s+`?wallet_account`?/i);
    expect(sql).toMatch(/ON DUPLICATE KEY UPDATE/i);
    // 재실행 시 갱신되는 컬럼들
    expect(sql).toMatch(/deposit_balance\s*=/i);
    expect(sql).toMatch(/credit_limit\s*=/i);
    expect(sql).toMatch(/credit_used_amount\s*=/i);
  });

  it('owner_type = SETTLEMENT_CODE 단일값으로 INSERT 한다', () => {
    expect(sql).toMatch(/'SETTLEMENT_CODE'/);
    // polymorphic owner_type (USER / COMPANY) 사용 금지
    expect(sql).not.toMatch(/'USER'\s*,\s*CONCAT/);
    expect(sql).not.toMatch(/owner_type\s*=\s*'USER'/i);
    expect(sql).not.toMatch(/owner_type\s*=\s*'COMPANY'/i);
  });

  it('balanceManagementType 분기를 포함하지 않는다 (모든 user 회사 단위 공유)', () => {
    // SQL 주석(-- 로 시작) 은 검사 제외, 실행 코드만 검사
    const executable = sql
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n');
    expect(executable).not.toMatch(/balanceManagementType/i);
    expect(executable).not.toMatch(/balance_management_type/i);
  });

  it('credit_used_amount 는 Σ user.allSettleAmount per company 이관, credit_excess_amount 는 0', () => {
    const insertBlock = sql.split(/INSERT INTO/)[1] ?? '';
    expect(insertBlock).toMatch(/credit_used_amount/);
    expect(insertBlock).toMatch(/credit_excess_amount/);
    // credit_used_amount: SUM(u.all_settle_amount) per companyId (SnakeNamingStrategy)
    expect(sql).toMatch(/SUM\(u\.all_settle_amount\)/);
    // credit_excess_amount: 여전히 0 (legacy 미존재, PR2 누적)
    expect(sql).toMatch(/0,?\s*--\s*credit_excess_amount/i);
  });

  it('4종 검증 쿼리 모두 존재한다', () => {
    // 3-1 deposit equality
    expect(sql).toMatch(/legacy_deposit/);
    expect(sql).toMatch(/wallet_deposit/);
    // 3-2 credit_limit equality
    expect(sql).toMatch(/legacy_credit_limit/);
    expect(sql).toMatch(/wallet_credit_limit/);
    // 3-3 credit_used equality (legacy_all_settle_amount → wallet_credit_used)
    expect(sql).toMatch(/legacy_all_settle_amount/);
    expect(sql).toMatch(/wallet_credit_used/);
    // 3-3b credit_excess wallet=0 검증
    expect(sql).toMatch(/wallet_credit_excess_should_be_0/);
  });

  it('settlement_code 중복 검증 (GROUP BY HAVING COUNT > 1) 쿼리가 있다', () => {
    expect(sql).toMatch(/GROUP BY\s+owner_type,\s*owner_id/i);
    expect(sql).toMatch(/HAVING\s+COUNT\(\*\)\s*>\s*1/i);
  });

  it('user_company.maximum_limit 를 credit_limit 으로 매핑한다 (SnakeNamingStrategy)', () => {
    // 실행 SQL 만 검사 (comment 제외)
    const executable = sql
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n');
    expect(executable).toMatch(/maximum_limit/);
    expect(executable).toMatch(/credit_limit/);
    // camelCase 잔존 금지 (DB 컬럼명은 snake_case)
    expect(executable).not.toMatch(/maximumLimit/);
    expect(executable).not.toMatch(/allSettleAmount/);
    // 잘못된 컬럼명 (legacy 미존재) 사용 금지
    expect(executable).not.toMatch(/c\.credit_limit/);
    expect(executable).not.toMatch(/c\.credit_used/);
  });
});
