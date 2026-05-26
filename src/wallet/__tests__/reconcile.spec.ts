import * as fs from 'fs';
import * as path from 'path';

/**
 * 20260527_wallet_legacy_reconcile.sql 구조 검증.
 * 실제 DB round-trip 은 staging dry-run 단계. 본 spec 은 정적 검증:
 *  - 4종 검사 섹션 존재 (A: 음수, B: drift, B-2: 회사 drift, C: 한도 초과)
 *  - billing_user_id 정의 (COALESCE client_user_id, user_id)
 *  - drift 식 (legacy - expected)
 *  - 회사 단위 집계 (user_company JOIN user)
 *  - read-only (UPDATE/INSERT/DELETE 0건)
 */
describe('20260527_wallet_legacy_reconcile.sql — 구조 검증', () => {
  const sqlPath = path.resolve(__dirname, '../../../sql/20260527_wallet_legacy_reconcile.sql');
  let sql: string;

  beforeAll(() => {
    sql = fs.readFileSync(sqlPath, 'utf8');
  });

  it('파일 존재 + 헤더 주석 보유', () => {
    expect(sql.length).toBeGreaterThan(500);
    expect(sql).toMatch(/Legacy Reconciler/i);
  });

  it('read-only — DML 0건', () => {
    // 본 reconciler 는 console 출력만. SELECT 만 허용.
    const executable = sql
      .split(/\r?\n/)
      .map((l) => l.replace(/--.*/, ''))
      .join('\n');
    expect(executable).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(executable).not.toMatch(/\bUPDATE\s+`?(?:user|user_company|order|wallet)/i);
    expect(executable).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(executable).not.toMatch(/\bDROP\b/i);
  });

  it('A) 음수 all_settle_amount 스캔', () => {
    expect(sql).toMatch(/all_settle_amount\s*<\s*0/);
  });

  it('B) 주문 합계 vs all_settle_amount drift', () => {
    expect(sql).toMatch(/order_active/i);
    expect(sql).toMatch(/expected_per_user/i);
    expect(sql).toMatch(/COALESCE\(o\.client_user_id,\s*o\.user_id\)/i);
    // active credit order 조건
    expect(sql).toMatch(/is_settle_complete\s*=\s*0/i);
    expect(sql).toMatch(/is_settle_balance\s*=\s*0\s+OR\s+is_credit_excess\s*=\s*1/i);
    expect(sql).toMatch(/all_settle_amount\s*!=\s*COALESCE\(e\.expected_all_settle,\s*0\)/i);
  });

  it('B-2) 회사 단위 drift', () => {
    expect(sql).toMatch(/user_company`?\s+c[\s\S]*?JOIN\s+`?user`?\s+u/i);
    expect(sql).toMatch(/SUM\(u\.all_settle_amount\)/i);
  });

  it('C) 회사 단위 maximum_limit 초과', () => {
    expect(sql).toMatch(/SUM\(u\.all_settle_amount\)\s*>\s*c\.maximum_limit/i);
  });

  it('E) 요약 카운트 — 운영자 한눈에', () => {
    expect(sql).toMatch(/negative_users/i);
    expect(sql).toMatch(/drift_users/i);
    expect(sql).toMatch(/over_limit_companies/i);
  });
});
