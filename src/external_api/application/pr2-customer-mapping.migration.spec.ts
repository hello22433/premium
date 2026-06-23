import * as fs from 'fs';
import * as path from 'path';

/**
 * PR2 매핑모드 마이그레이션 구조 검증 (ralplan PR2 Phase 1, MED-2).
 * 실제 DB round-trip 은 staging dry-run 단계에서 수행. 이 spec 은 정적 invariant 검증:
 *  - api_customer_mapping 테이블 + active-only unique(generated column, CASE WHEN)
 *  - triple unique 대안 미사용(설계결함 방지)
 *  - order external_order_id / external_customer_id 컬럼 + (api_app_id, external_order_id) 조건 유니크
 *  - M2 백필 no-op(sentinel 미생성, default 코드 fallback)
 */
describe('PR2 api_customer_mapping 마이그레이션 — 구조 검증', () => {
  const sqlPath = path.resolve(__dirname, '../../../sql/migrations/20260622_pr2_customer_mapping.sql');
  let sql: string;

  beforeAll(() => {
    sql = fs.readFileSync(sqlPath, 'utf8');
  });

  it('api_customer_mapping 테이블을 생성한다', () => {
    expect(sql).toMatch(/CREATE\s+TABLE\s+`?api_customer_mapping`?/i);
    expect(sql).toMatch(/`api_app_id`\s+BIGINT\s+NOT NULL/i);
    expect(sql).toMatch(/`external_customer_id`\s+VARCHAR\(191\)\s+NOT NULL/i);
    expect(sql).toMatch(/`billing_user_id`\s+INT\s+NOT NULL/i);
    expect(sql).toMatch(/ENGINE=InnoDB/i);
  });

  it('active-only unique 를 generated column active_key(CASE WHEN) + UNIQUE(api_app_id, active_key) 로 구현한다', () => {
    // 레포 컨벤션: IF() 가 아니라 CASE WHEN
    expect(sql).toMatch(
      /`active_key`[\s\S]*GENERATED ALWAYS AS\s*\(\s*CASE WHEN\s+`deleted_at`\s+IS NULL\s+THEN\s+`external_customer_id`\s+ELSE NULL END\s*\)\s+STORED/i,
    );
    expect(sql).toMatch(/UNIQUE KEY\s+`uk_api_customer_mapping_active`\s*\(\s*`api_app_id`\s*,\s*`active_key`\s*\)/i);
  });

  it('triple unique(external_customer_id, deleted_at) 대안을 사용하지 않는다(NULL-distinct 결함 방지)', () => {
    // UNIQUE 인덱스에 deleted_at 을 포함하는 형태가 없어야 한다
    expect(sql).not.toMatch(/UNIQUE[^\n]*`external_customer_id`[^\n]*`deleted_at`/i);
    // generated column 식에 IF() 를 쓰지 않는다(레포 컨벤션 CASE WHEN)
    expect(sql).not.toMatch(/GENERATED ALWAYS AS\s*\(\s*IF\(/i);
  });

  it('M2 백필은 no-op(sentinel 미생성, default 코드 fallback)임을 명시한다', () => {
    expect(sql).toMatch(/M2[\s\S]*no-op/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+`?api_customer_mapping`?/i);
  });

  it('order 에 external_order_id / external_customer_id 컬럼을 nullable 로 추가한다', () => {
    expect(sql).toMatch(/ALTER TABLE\s+`order`[\s\S]*ADD COLUMN\s+`external_order_id`\s+VARCHAR\(191\)\s+NULL/i);
    expect(sql).toMatch(/ADD COLUMN\s+`external_customer_id`\s+VARCHAR\(191\)\s+NULL/i);
  });

  it('order (api_app_id, external_order_id) 조건 유니크를 추가한다(NULL 다중 허용)', () => {
    expect(sql).toMatch(
      /ADD UNIQUE KEY\s+`uk_order_api_app_external_order`\s*\(\s*`api_app_id`\s*,\s*`external_order_id`\s*\)/i,
    );
  });

  it('additive only — 기존 컬럼/테이블 DROP 이 활성 구문에 없다(롤백 주석 제외)', () => {
    // 주석(--)을 제거한 활성 SQL 에 DROP 이 없어야 한다
    const activeSql = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(activeSql).not.toMatch(/\bDROP\b/i);
  });
});
