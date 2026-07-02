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
    expect(executableSql).toMatch(/_partner_settle_backfill_skip_log/i);
    expect(executableSql).toMatch(/SIGNAL\s+SQLSTATE\s+'45000'/i);
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
    expect(executableSql).toMatch(/ud\.primary_category\s*=\s*\(\s*SELECT\s+b\.name_korean/i);
  });

  it('단건 할인 조회는 커서 NOT FOUND 핸들러를 오염시키는 SELECT INTO 패턴을 쓰지 않는다', () => {
    expect(executableSql).not.toMatch(/SELECT\s+ud\.price_percent\s*,\s*ud\.price_adjustment\s+INTO\s+v_brand_fee/i);
    expect(executableSql).not.toMatch(/SELECT\s+ud\.price_percent\s*,\s*ud\.price_adjustment\s+INTO\s+v_category_fee/i);
    expect(executableSql).not.toMatch(/SELECT\s+ud\.price_percent\s*,\s*ud\.price_adjustment\s+INTO\s+v_group_fee/i);
  });
});
