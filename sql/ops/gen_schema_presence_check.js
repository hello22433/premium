/**
 * 마이그레이션 파일들이 만드는 스키마 객체(테이블/컬럼/인덱스/제약)를 훑어
 * **읽기 전용** 존재여부 점검 SQL 을 생성한다.
 *
 * 목적: 상용 배포 전에 "어떤 마이그레이션이 아직 안 들어갔는지" 를 한 방에 본다.
 * 파일명이 아니라 실제 스키마 객체로 판정하므로, 적용 이력 테이블이 없어도 쓸 수 있다.
 *
 * 오탐을 줄이기 위해 다음을 처리한다:
 *  - 주석(`--`, 블록) 제거 — 롤백 예시 DDL 이 잡히면 전부 오탐이 된다
 *  - DROP 추적 — 나중 마이그레이션이 지운 객체는 "있으면 안 되는" 것이므로 기대 목록에서 뺀다
 *  - 제약 종류 구분 — CHECK 는 CHECK_CONSTRAINTS, FK 는 TABLE_CONSTRAINTS 에 있다.
 *    둘 다 STATISTICS(인덱스)에 이름이 안 남을 수 있어 인덱스로 조회하면 전부 MISSING 으로 뜬다
 *  - `IF NOT EXISTS` 를 객체명으로 오인하지 않기
 *
 * 한계(의도적): 백필/UPDATE 전용 마이그레이션은 DDL 이 없어 잡히지 않는다.
 *
 * 사용: node sql/ops/gen_schema_presence_check.js > sql/ops/schema_presence_check.generated.sql
 */
const fs = require('fs');
const path = require('path');

const DIRS = ['sql/migrations', 'migration'];

/** kind: TABLE | COLUMN | INDEX | CHECK | FK */
const expected = new Map(); // key -> { file, kind, table, name }

const key = (kind, table, name) => `${kind}\u0000${table}\u0000${name ?? ''}`;
const unq = (s) => s.replace(/[`'"]/g, '').trim();
const isNoise = (name) => !name || /^(IF|NOT|EXISTS|UNIQUE|INDEX|KEY|COLUMN|CONSTRAINT)$/i.test(name);

// ADD/DROP 은 파일·문장 안의 등장 순서대로 적용한다. 한 ALTER 안에서 DROP 후 같은 이름을 다시
// ADD 하는 재정의(예: chk_partner_settle_ledger_transition_pair)를 순서 무시하면 기대 목록에서
// 통째로 사라져 오히려 미적용을 놓친다.
const ops = []; // { seq, op: 'add'|'drop', file, kind, table, name }
let seq = 0;

const add = (file, kind, table, name) => {
  if (isNoise(table)) return;
  if (kind !== 'TABLE' && isNoise(name)) return;
  ops.push({ seq: seq++, op: 'add', file, kind, table, name: name ?? null });
};

const drop = (kind, table, name) => {
  if (isNoise(table)) return;
  ops.push({ seq: seq++, op: 'drop', kind, table, name: name ?? null });
};

for (const dir of DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const entry of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const file = path.posix.join(dir, entry);
    const sql = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      // `$` 를 쓰면 CRLF 파일에서 `.` 가 `\r` 를 넘지 못해 주석이 하나도 안 지워진다.
      .map((line) => line.replace(/--.*/, ''))
      .join('\n');

    const tableOps = [];
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`\w]+)/gi))
      tableOps.push({ at: m.index, run: () => add(file, 'TABLE', unq(m[1]), null) });
    for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([`\w]+)/gi))
      tableOps.push({ at: m.index, run: () => drop('TABLE', unq(m[1]), null) });
    for (const o of tableOps.sort((a, b) => a.at - b.at)) o.run();

    for (const stmt of sql.split(';')) {
      const alter = stmt.match(/ALTER\s+TABLE\s+([`\w]+)([\s\S]*)/i);
      if (!alter) continue;
      const table = unq(alter[1]);
      const body = alter[2];

      // 문장 안에서도 등장 위치 순으로 적용해야 "DROP 후 재ADD" 가 살아남는다.
      const local = [];
      for (const m of body.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([`\w]+)/gi))
        local.push({ at: m.index, run: () => add(file, 'COLUMN', table, unq(m[1])) });
      for (const m of body.matchAll(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([`\w]+)/gi))
        local.push({ at: m.index, run: () => drop('COLUMN', table, unq(m[1])) });

      for (const m of body.matchAll(/ADD\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:INDEX|KEY)\s+([`\w]+)/gi))
        local.push({ at: m.index, run: () => add(file, 'INDEX', table, unq(m[1])) });
      for (const m of body.matchAll(/DROP\s+(?:INDEX|KEY)\s+([`\w]+)/gi))
        local.push({ at: m.index, run: () => drop('INDEX', table, unq(m[1])) });

      // ADD CONSTRAINT 는 뒤따르는 키워드로 종류가 갈린다. CHECK/FK 는 인덱스 카탈로그에 없다.
      for (const m of body.matchAll(/ADD\s+CONSTRAINT\s+([`\w]+)\s+(CHECK|FOREIGN\s+KEY|UNIQUE|PRIMARY\s+KEY)/gi)) {
        const kw = m[2].toUpperCase().replace(/\s+/g, ' ');
        const kind = kw === 'CHECK' ? 'CHECK' : kw === 'FOREIGN KEY' ? 'FK' : 'INDEX';
        local.push({ at: m.index, run: () => add(file, kind, table, unq(m[1])) });
      }
      for (const m of body.matchAll(/DROP\s+(?:CHECK|CONSTRAINT)\s+([`\w]+)/gi))
        local.push({
          at: m.index,
          run: () => {
            drop('CHECK', table, unq(m[1]));
            drop('FK', table, unq(m[1]));
            drop('INDEX', table, unq(m[1]));
          },
        });
      for (const m of body.matchAll(/DROP\s+FOREIGN\s+KEY\s+([`\w]+)/gi))
        local.push({ at: m.index, run: () => drop('FK', table, unq(m[1])) });

      for (const o of local.sort((a, b) => a.at - b.at)) o.run();
    }
  }
}

for (const o of ops) {
  const k = key(o.kind, o.table, o.name);
  if (o.op === 'drop') expected.delete(k);
  else if (!expected.has(k)) expected.set(k, { file: o.file, kind: o.kind, table: o.table, name: o.name });
}

const rows = [...expected.values()]
  .map(
    (o) =>
      `  SELECT ${q(o.file)} AS file, ${q(o.kind)} AS kind, ${q(o.table)} AS tbl, ${o.name ? q(o.name) : 'NULL'} AS obj`,
  );

function q(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

process.stdout.write(`-- 자동 생성 (sql/ops/gen_schema_presence_check.js). 읽기 전용 — DDL/DML 없음.
-- 대상 DB 에 접속해 그대로 실행한다. status='MISSING' 인 행이 미적용분이다.
--
-- 판정 대상: 마이그레이션이 만드는 테이블/컬럼/인덱스/CHECK/FK.
--   - 나중 마이그레이션이 DROP 하는 객체는 기대 목록에서 제외했다(있으면 오히려 이상).
--   - CHECK/FK 는 인덱스 카탈로그가 아니라 제약 카탈로그에서 확인한다.
-- 한계: 백필 전용 마이그레이션은 DDL 이 없어 이 목록에 나오지 않는다(별도 확인 필요).

WITH expected AS (
${rows.join('\n  UNION ALL\n')}
)
SELECT e.file, e.kind, e.tbl, e.obj,
       CASE
         WHEN e.kind = 'TABLE' THEN
           IF(EXISTS (SELECT 1 FROM information_schema.TABLES t
                       WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME = e.tbl), 'ok', 'MISSING')
         WHEN e.kind = 'COLUMN' THEN
           IF(EXISTS (SELECT 1 FROM information_schema.COLUMNS c
                       WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = e.tbl AND c.COLUMN_NAME = e.obj),
              'ok', 'MISSING')
         WHEN e.kind = 'INDEX' THEN
           IF(EXISTS (SELECT 1 FROM information_schema.STATISTICS s
                       WHERE s.TABLE_SCHEMA = DATABASE() AND s.TABLE_NAME = e.tbl AND s.INDEX_NAME = e.obj),
              'ok', 'MISSING')
         ELSE
           IF(EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS tc
                       WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = e.tbl
                         AND tc.CONSTRAINT_NAME = e.obj), 'ok', 'MISSING')
       END AS status
  FROM expected e
 ORDER BY status DESC, e.file, e.kind, e.tbl, e.obj;
`);
