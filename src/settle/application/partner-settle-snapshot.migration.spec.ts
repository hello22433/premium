import * as fs from 'fs';
import * as path from 'path';

describe('20260629_add_partner_settle_snapshot.sql', () => {
  const sqlPath = path.resolve(__dirname, '../../../sql/migrations/20260629_add_partner_settle_snapshot.sql');
  let sql: string;
  let executableSql: string;

  beforeAll(() => {
    sql = fs.readFileSync(sqlPath, 'utf8');
    executableSql = sql
      .split(/\r?\n/)
      .map((line) => line.replace(/--.*/, ''))
      .join('\n');
  });

  it('카테고리/상품군 동시 매칭은 고정 우선순위가 아니라 높은 수수료율을 선택한다', () => {
    expect(executableSql).toMatch(/v_category_fee\s*>=\s*v_group_fee/i);
    expect(executableSql).toMatch(/partner_settle_fee\s*=\s*v_category_fee/i);
    expect(executableSql).toMatch(/partner_settle_fee\s*=\s*v_group_fee/i);
    expect(executableSql).not.toMatch(/COALESCE\s*\(\s*ud_brand\.price_percent\s*,\s*ud_category\.price_percent\s*,\s*ud_group\.price_percent/i);
  });

  it('카테고리/상품군 할인 방향 충돌은 자동 업데이트하지 않고 마이그레이션을 차단한다', () => {
    expect(executableSql).toMatch(/v_category_adj\s*<=>\s*v_group_adj/i);
    expect(executableSql).toMatch(/SIGNAL\s+SQLSTATE\s+'45000'/i);
    expect(executableSql).toMatch(/CATEGORY\/PRODUCT_GROUP priceAdjustment conflict/i);
    expect(executableSql).not.toMatch(/CATEGORY\/PRODUCT_GROUP priceAdjustment 방향 충돌/i);
  });

  it('BULK 매칭은 findMatchingDiscount의 첫 매칭과 맞추기 위해 id 오름차순으로 고정한다', () => {
    expect(executableSql).toMatch(/ud\.category\s*=\s*'BRAND'[\s\S]{0,180}?ud\.method\s*=\s*'BULK'[\s\S]{0,220}?ORDER\s+BY\s+ud\.id\s+ASC[\s\S]{0,40}?LIMIT\s+1/i);
    expect(executableSql).toMatch(/ud\.category\s*=\s*'CATEGORY'[\s\S]{0,180}?ud\.method\s*=\s*'BULK'[\s\S]{0,220}?ORDER\s+BY\s+ud\.id\s+ASC[\s\S]{0,40}?LIMIT\s+1/i);
    expect(executableSql).toMatch(/ud\.category\s*=\s*'PRODUCT_GROUP'[\s\S]{0,180}?ud\.method\s*=\s*'BULK'[\s\S]{0,220}?ORDER\s+BY\s+ud\.id\s+ASC[\s\S]{0,40}?LIMIT\s+1/i);
  });

  it('SECTION 계약을 0/null로 백필하지 않고 snapshot price 기준으로 구간 판정한다', () => {
    expect(executableSql).toMatch(/COALESCE\s*\(\s*opm\.snapshot_product_price\s*,\s*p\.price\s*\)/i);
    expect(executableSql).toMatch(/ud\.method\s*=\s*'SECTION'/i);
    expect(executableSql).toMatch(/LEAD\s*\(\s*CAST\s*\(\s*ud\.`range`\s+AS\s+SIGNED\s*\)\s*\)/i);
    expect(executableSql).toMatch(/v_price\s*>\s*v_prev_upper/i);
  });

  it('BRAND 계약도 BULK뿐 아니라 SECTION 구간 판정을 지원한다', () => {
    expect(executableSql).toMatch(/DECLARE\s+brand_section_cur\s+CURSOR/i);
    expect(executableSql).toMatch(/ud\.category\s*=\s*'BRAND'[\s\S]{0,400}?ud\.method\s*=\s*'SECTION'/i);
    expect(executableSql).toMatch(/ud\.primary_category\s+COLLATE\s+utf8mb4_bin\s*=\s*\(\s*SELECT\s+b\.name_korean/i);
  });

  it('단건 할인 조회는 커서 NOT FOUND 핸들러를 오염시키는 SELECT INTO 패턴을 쓰지 않는다', () => {
    expect(executableSql).not.toMatch(/SELECT\s+ud\.price_percent\s*,\s*ud\.price_adjustment\s+INTO\s+v_brand_fee/i);
    expect(executableSql).not.toMatch(/SELECT\s+ud\.price_percent\s*,\s*ud\.price_adjustment\s+INTO\s+v_category_fee/i);
    expect(executableSql).not.toMatch(/SELECT\s+ud\.price_percent\s*,\s*ud\.price_adjustment\s+INTO\s+v_group_fee/i);
  });

  it('CATEGORY 매칭은 classification_id가 양쪽 NULL이어도 매칭되도록 NULL-safe 비교를 쓴다', () => {
    expect(executableSql).toMatch(/ud\.classification_id\s*<=>\s*v_classification_id/i);
    expect(executableSql).not.toMatch(/ud\.classification_id\s*=\s*v_classification_id/i);
  });

  it('브랜드명/상품군 문자열 비교는 TS의 ===와 맞추기 위해 바이너리 collation을 강제한다', () => {
    const binCompares = executableSql.match(
      /ud\.(primary_category|`group`)\s+COLLATE\s+utf8mb4_bin\s*=/gi,
    );
    // BRAND BULK 2 + BRAND SECTION 1 + PRODUCT_GROUP BULK 2 + PRODUCT_GROUP SECTION 1
    expect(binCompares).toHaveLength(6);
    expect(executableSql).not.toMatch(/ud\.primary_category\s*=/i);
    expect(executableSql).not.toMatch(/ud\.`group`\s*=/i);
  });

  it('SECTION 후보는 findDiscountByMethod처럼 range가 비어있는 행을 제외한다', () => {
    const sectionRangeGuards = executableSql.match(
      /ud\.`range`\s+IS\s+NOT\s+NULL\s+AND\s+ud\.`range`\s*<>\s*''/gi,
    );
    expect(sectionRangeGuards).toHaveLength(3);
  });

  it('SECTION 정렬은 커서와 LEAD window 모두 range ASC + id ASC로 고정한다', () => {
    const sectionOrderBys = executableSql.match(/ORDER\s+BY\s+CAST\(ud\.`range`\s+AS\s+SIGNED\)\s+ASC\s*,\s*ud\.id\s+ASC/gi);
    // 커서 3개 + LEAD window 6개(커서당 next_range_val / next_compare_cond)
    expect(sectionOrderBys).toHaveLength(9);
    expect(executableSql).not.toMatch(/ORDER\s+BY\s+CAST\(ud\.`range`\s+AS\s+SIGNED\)\s+ASC\s*(?![\s,]*ud\.id)/i);
  });

  it('brand/partner_company/user_discount 의 soft-delete 가시성을 호출부 relations 로딩과 맞춘다', () => {
    expect(executableSql).toMatch(
      /LEFT\s+JOIN\s+`partner_company`\s+pc\s+ON\s+pc\.id\s*=\s*p\.partner_company_id\s+AND\s+pc\.deleted_at\s+IS\s+NULL/i,
    );
    expect(executableSql).toMatch(
      /LEFT\s+JOIN\s+`brand`\s+b\s+ON\s+b\.id\s*=\s*p\.brand_id\s+AND\s+b\.deleted_at\s+IS\s+NULL/i,
    );
    expect(executableSql).toMatch(/FROM\s+`user_discount`\s*\n?\s*WHERE\s+deleted_at\s+IS\s+NULL/i);
    // 삭제된 관계는 id 를 NULL 로 남겨야 하므로 target 컬럼이 NOT NULL 이면 안 된다
    expect(executableSql).not.toMatch(/`partner_company_id`\s+INT\s+NOT\s+NULL/i);
    expect(executableSql).not.toMatch(/`brand_id`\s+INT\s+NOT\s+NULL/i);
  });

  it('backfill 시작 시점의 user_discount 스냅샷만 사용해 도중 할인조건 변경 영향을 차단한다', () => {
    expect(executableSql).toMatch(/CREATE\s+TEMPORARY\s+TABLE\s+`_partner_settle_backfill_discount`/i);
    expect(executableSql).toMatch(/INSERT\s+INTO\s+`_partner_settle_backfill_discount`/i);

    const afterDiscountSnapshot = executableSql.slice(
      executableSql.search(/DROP\s+PROCEDURE\s+IF\s+EXISTS\s+backfill_partner_settle_snapshot/i),
    );
    expect(afterDiscountSnapshot).not.toMatch(/FROM\s+`user_discount`\s+ud/i);
    expect(afterDiscountSnapshot).toMatch(/FROM\s+`_partner_settle_backfill_discount`\s+ud/i);
  });

  it('컬럼 추가는 information_schema 존재 확인 뒤 수행해 스크립트 전체가 재실행 안전하다', () => {
    expect(executableSql).toMatch(/information_schema\.COLUMNS/i);
    expect(executableSql).toMatch(/COLUMN_NAME\s*=\s*'partner_settle_price_adjustment'/i);
    expect(executableSql).toMatch(/COLUMN_NAME\s*=\s*'partner_settle_fee'/i);
    // 가드 없는 최상위(bare) ALTER ADD COLUMN 이 존재하면 재실행 시 duplicate column 으로 실패한다
    expect(executableSql).not.toMatch(/^ALTER\s+TABLE\s+`order_product_mapping`/im);
  });

  it('target 구체화 이후 새로 생긴 NULL 스냅샷 row도 전체 테이블 기준 검증으로 차단한다', () => {
    expect(executableSql).toMatch(/remaining_null_total/i);
    expect(executableSql).toMatch(/partner settle backfill blocked: unresolved NULL rows remain/i);
  });
});
