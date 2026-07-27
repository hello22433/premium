/**
 * 금융 PII(계좌/카드번호) 컬럼 평문 → 암호화 1회성 백필 스크립트.
 *
 * 컬럼명: TypeORM SnakeNamingStrategy → 엔티티 bankNumber/cardNumber/bankAccount 의 물리 컬럼은
 *         bank_number/card_number/bank_account. 이 스크립트의 raw SQL 은 물리 컬럼명을 사용한다.
 * 대상: user.bank_number, user.card_number, partner_company.bank_number, order_delivery.bank_account
 * 옵션(기본 off, 필요 시에만 on): user_company.bank_number/card_number
 *   - sql/ops/ops_20260723_financial_pii_preaudit.sql [게이트 1] COUNT>0 인 경우에만 켠다.
 *   - 켜는 방법: --include-user-company 플래그 또는 env INCLUDE_USER_COMPANY=1
 *
 * ── 실행 순서(반드시 이 순서) ──────────────────────────────────────────
 *   1. sql/ops/ops_20260723_financial_pii_preaudit.sql (READ-ONLY) 실행 → 길이/포함범위 판정.
 *   2. Release1(read safeDecrypt), Release2(write encrypt 균일 가드) 코드가 이미 배포되어 있는지 확인.
 *      (백필 전에 write 경로가 암호화하지 않으면, 백필 직후 다시 평문으로 덮어써질 수 있다.)
 *   3. 반드시 --dry-run 먼저 실행. updated/skipped/failed/ambiguous 카운트를 확인한다.
 *   4. ambiguous 로 집계된 행은 자동 UPDATE 되지 않는다 — 개별 검수 후 수동 처리(런북 참고).
 *   5. --dry-run 없이 실제 실행. 백업 스냅샷 생성이 선행되지 않으면 스크립트가 중단된다(하드 전제).
 *   6. 완료 후 재실행 시 변경 0건(멱등)인지 확인 — 이중 암호화 없음을 보장.
 *
 * ── 판별 규칙(non-throw 불변식, dedup) ─────────────────────────────────
 *   - 값이 null / '' / '-'(DESTROY_VALUE, 정기파기 sentinel) 이면 skip (파기된 값은 건드리지 않음).
 *   - decryptDeliveryTarget(값) 시도:
 *       throw                                              → 평문 확정 → encryptDeliveryTarget 후 UPDATE
 *       성공 & 복호결과가 /^[0-9-]+$/ 이고 길이 <= 25       → 이미 암호문(정상 계좌/카드 형태로 복호됨) 확정 → skip
 *       성공 & 위 형태에 해당하지 않음                      → 모호(ambiguous) → 카운트만 증가, 자동 UPDATE 금지
 *   - 이중 암호화 방지: 위 규칙으로 "이미 암호문"인 행은 재암호화하지 않는다.
 *
 * ── 조건부 UPDATE(바이트정확, 동시 write 보호) ──────────────────────────
 *   UPDATE <table> SET <col> = ? WHERE id = ? AND BINARY <col> = ?  (원본 평문 바이트 그대로)
 *   → 백필 조회 시점과 UPDATE 시점 사이에 앱이 그 값을 이미 암호화해 덮어썼다면(라이브 write),
 *     BINARY 비교가 실패해 UPDATE 는 0행 영향 → no-op. 이중 암호화 없음.
 *
 * ── 배치/체크포인트 ──────────────────────────────────────────────────
 *   order_delivery 는 대량 테이블이므로 PK(id) range 배칭으로 순회하고, 마지막으로 처리한 id를
 *   진행 로그로 남겨(표준출력) 중단 시 --resume-from-id 로 재개할 수 있다.
 *
 * ── 실행 예시 ────────────────────────────────────────────────────────
 *   # 1) dry-run (기본 권장, 아무 것도 쓰지 않음)
 *   DATABASE_HOST=... DATABASE_PORT=3306 DATABASE_USERNAME=... DATABASE_PASSWORD=... DATABASE_DATABASE=... \
 *   DELIVERY_TARGET_CRYPTO_KEY=... DELIVERY_TARGET_CRYPTO_IV=... \
 *   npx ts-node migration/encrypt-financial-pii-backfill.ts --dry-run
 *
 *   # 2) 실제 실행 (백업 스냅샷 자동 생성 후 진행)
 *   npx ts-node migration/encrypt-financial-pii-backfill.ts
 *
 *   # 3) user_company 포함 + order_delivery 배치 크기/재개 지점 지정
 *   npx ts-node migration/encrypt-financial-pii-backfill.ts --include-user-company --batch-size=2000 --resume-from-id=500000
 *
 * ── 주의 ────────────────────────────────────────────────────────────
 *   - 실행 주체는 운영/DBA(에이전트는 DB 미접근). 이 파일은 스크립트 저작물이며 실제 실행은 사용자 몫.
 *   - 백업 없이 실행 금지. 백업 테이블 생성이 실패하면 스크립트는 아무 UPDATE 도 하지 않고 종료한다.
 *   - 모호(ambiguous) 행은 이 스크립트가 절대 자동으로 건드리지 않는다. 수동 검토 후 처리한다.
 */

/* eslint-disable no-console */
import * as crypto from 'crypto';
import * as mysql from 'mysql2/promise';

// ─────────────────────────────────────────────────────────────
// CLI / env
// ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (name: string): boolean => argv.includes(`--${name}`);
const getOpt = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
};

const DRY_RUN = hasFlag('dry-run');
const INCLUDE_USER_COMPANY = hasFlag('include-user-company') || process.env.INCLUDE_USER_COMPANY === '1';
const BATCH_SIZE = Number(getOpt('batch-size') ?? process.env.BACKFILL_BATCH_SIZE ?? 5000);
const RESUME_FROM_ID = Number(getOpt('resume-from-id') ?? process.env.BACKFILL_RESUME_FROM_ID ?? 0);
// 실행 단위 고정 run id — 백업 스냅샷 테이블 접미사에 사용(여러 테이블 백업 세트를 한 실행으로 상관 추적).
const BACKFILL_RUN_ID =
  process.env.BACKFILL_RUN_ID ?? new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

const DESTROY_VALUE = '-';
const ALREADY_CIPHERTEXT_SHAPE = /^[0-9-]+$/;
const ALREADY_CIPHERTEXT_MAX_LEN = 25;

// ─────────────────────────────────────────────────────────────
// 인자 검증 (fail-fast) — 잘못된 배치/resume 값으로 인한 무한 루프/무실행 방지
// ─────────────────────────────────────────────────────────────
function validateOptions(): void {
  const rawBatch = getOpt('batch-size') ?? process.env.BACKFILL_BATCH_SIZE;
  if (!Number.isSafeInteger(BATCH_SIZE) || BATCH_SIZE < 1) {
    throw new Error(
      `invalid --batch-size: "${rawBatch ?? ''}" — 1 이상의 안전한 정수여야 합니다(해석값=${BATCH_SIZE}). ` +
        `0/음수/비정수는 order_delivery 배칭이 진행되지 않거나(무한 루프) 조용히 건너뜁니다.`,
    );
  }
  const rawResume = getOpt('resume-from-id') ?? process.env.BACKFILL_RESUME_FROM_ID;
  if (!Number.isSafeInteger(RESUME_FROM_ID) || RESUME_FROM_ID < 0) {
    throw new Error(
      `invalid --resume-from-id: "${rawResume ?? ''}" — 0 이상의 안전한 정수여야 합니다(해석값=${RESUME_FROM_ID}).`,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// CryptoCipher.encryptDeliveryTarget / decryptDeliveryTarget 와 동일 구현
// (앱 코드와 별개 프로세스이므로 이 스크립트 안에서 그대로 재구현한다. 로직은 절대 분기하지 않는다:
//  src/common/infra/crypto.cipher.ts 의 encryptDeliveryTarget/decryptDeliveryTarget 과 바이트 단위 동일)
// ─────────────────────────────────────────────────────────────
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

function encryptDeliveryTarget(data: string): string {
  const key = requireEnv('DELIVERY_TARGET_CRYPTO_KEY');
  const iv = requireEnv('DELIVERY_TARGET_CRYPTO_IV');
  const keyBuffer = Buffer.from(key, 'utf8');
  const ivBuffer = Buffer.from(iv, 'utf8');
  const cipher = crypto.createCipheriv('aes-256-cbc', keyBuffer, ivBuffer);
  let encrypted = cipher.update(data, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
}

function decryptDeliveryTarget(encryptedData: string): string {
  const key = requireEnv('DELIVERY_TARGET_CRYPTO_KEY');
  const iv = requireEnv('DELIVERY_TARGET_CRYPTO_IV');
  const keyBuffer = Buffer.from(key, 'utf8');
  const ivBuffer = Buffer.from(iv, 'utf8');
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer, ivBuffer);
  let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ─────────────────────────────────────────────────────────────
// dedup 판별
// ─────────────────────────────────────────────────────────────
type Classification =
  | { kind: 'skip-empty' }
  | { kind: 'skip-already-ciphertext' }
  | { kind: 'plaintext'; ciphertext: string }
  | { kind: 'ambiguous' };

function classify(value: string): Classification {
  if (value === null || value === undefined || value === '' || value === DESTROY_VALUE) {
    return { kind: 'skip-empty' };
  }
  try {
    const decrypted = decryptDeliveryTarget(value);
    if (ALREADY_CIPHERTEXT_SHAPE.test(decrypted) && decrypted.length <= ALREADY_CIPHERTEXT_MAX_LEN) {
      return { kind: 'skip-already-ciphertext' };
    }
    return { kind: 'ambiguous' };
  } catch {
    return { kind: 'plaintext', ciphertext: encryptDeliveryTarget(value) };
  }
}

// ─────────────────────────────────────────────────────────────
// 카운터
// ─────────────────────────────────────────────────────────────
interface Counters {
  updated: number;
  skipped: number;
  failed: number;
  ambiguous: number;
}
function newCounters(): Counters {
  return { updated: 0, skipped: 0, failed: 0, ambiguous: 0 };
}

// ─────────────────────────────────────────────────────────────
// 백업 스냅샷 (하드 전제 — 실패 시 즉시 중단)
// ─────────────────────────────────────────────────────────────
async function requireBackupSnapshot(conn: mysql.Connection, table: string, column: string): Promise<void> {
  const runId = BACKFILL_RUN_ID;
  const backupTable = `_bak_${table}_${column}_${runId}`;

  if (DRY_RUN) {
    console.log(`[backup:dry-run] would create ${backupTable} AS SELECT id, ${column} FROM ${table}`);
    return;
  }

  try {
    const [existsRows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
      [backupTable],
    );
    const exists = Number(existsRows[0]?.c ?? 0) > 0;

    if (exists) {
      // 동일 run-id 재실행: 기존 백업을 재사용한다. 백업은 최초 실행 시점의 원본 평문을 보존하므로
      // '현재' 원본 테이블 행수와 비교하지 않는다(라이브 write로 원본 행수가 달라져도 백업은 여전히 유효).
      // 대신 백업 테이블이 백업으로서 필수 구조(id, 대상 컬럼)를 갖는지만 검증한다.
      const [colRows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`,
        [backupTable],
      );
      const cols = new Set((colRows as mysql.RowDataPacket[]).map((r) => String(r.COLUMN_NAME)));
      if (!cols.has('id') || !cols.has(column)) {
        throw new Error(
          `기존 백업 ${backupTable} 구조 불일치: 필수 컬럼(id, ${column})이 없습니다. ` +
            `다른 BACKFILL_RUN_ID를 지정하거나 기존 백업을 확인하세요.`,
        );
      }
      const [bakRows] = await conn.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS c FROM \`${backupTable}\``);
      const backedUp = Number(bakRows[0]?.c ?? 0);
      console.log(
        `[backup] ${backupTable} 재사용(${backedUp} rows, 구조 검증 완료) — 동일 run-id 재실행. ` +
          `현재 원본 행수와 비교하지 않음(라이브 write 대응).`,
      );
      return;
    }

    // 최초 생성: 생성 직후 백업 행수 == 원본 행수(생성 시점 스냅샷)로 무결성 확인.
    const [origRows] = await conn.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS c FROM \`${table}\``);
    const original = Number(origRows[0]?.c ?? 0);
    await conn.query(
      `CREATE TABLE \`${backupTable}\` AS SELECT id, \`${column}\` AS ${column}, NOW() AS backfill_backup_at FROM \`${table}\``,
    );
    const [bakRows] = await conn.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS c FROM \`${backupTable}\``);
    const backedUp = Number(bakRows[0]?.c ?? 0);
    if (backedUp !== original) {
      throw new Error(
        `backup row-count mismatch for ${table}.${column}: backup=${backedUp} original=${original}`,
      );
    }
    console.log(`[backup] ${backupTable} created (${backedUp} rows) — hard prerequisite satisfied.`);
  } catch (err) {
    throw new Error(
      `백업 스냅샷 생성/검증 실패(${table}.${column}) — 백필을 중단합니다. 원인: ${(err as Error).message}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// 단건/소량 테이블 백필 (user, partner_company, user_company)
// ─────────────────────────────────────────────────────────────
async function backfillSimpleTable(
  conn: mysql.Connection,
  table: string,
  column: string,
  counters: Counters,
): Promise<void> {
  await requireBackupSnapshot(conn, table, column);

  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT id, \`${column}\` AS val FROM \`${table}\` WHERE \`${column}\` IS NOT NULL AND \`${column}\` <> ''`,
  );

  for (const row of rows as Array<{ id: number; val: string }>) {
    const result = classify(row.val);
    if (result.kind === 'skip-empty' || result.kind === 'skip-already-ciphertext') {
      counters.skipped += 1;
      continue;
    }
    if (result.kind === 'ambiguous') {
      counters.ambiguous += 1;
      console.warn(`[ambiguous] ${table}.${column} id=${row.id} — 수동 검토 필요, 자동 UPDATE 하지 않음.`);
      continue;
    }

    if (DRY_RUN) {
      counters.updated += 1;
      continue;
    }

    try {
      const [res] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE \`${table}\` SET \`${column}\` = ? WHERE id = ? AND BINARY \`${column}\` = ?`,
        [result.ciphertext, row.id, row.val],
      );
      if (res.affectedRows === 1) {
        counters.updated += 1;
      } else {
        // 조회 시점 이후 라이브 write 가 이미 값을 바꿔놓은 경우 — no-op, 실패 아님(재실행 시 재평가됨)
        counters.skipped += 1;
      }
    } catch (err) {
      counters.failed += 1;
      console.error(`[failed] ${table}.${column} id=${row.id}: ${(err as Error).message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// order_delivery.bankAccount — 대량 테이블, PK-range 배칭 + 체크포인트
// ─────────────────────────────────────────────────────────────
async function backfillOrderDelivery(conn: mysql.Connection, counters: Counters): Promise<void> {
  const table = 'order_delivery';
  const column = 'bank_account';
  await requireBackupSnapshot(conn, table, column);

  const [maxRows] = await conn.query<mysql.RowDataPacket[]>(`SELECT MAX(id) AS maxId FROM \`${table}\``);
  const maxId = Number(maxRows[0]?.maxId ?? 0);

  let lastId = RESUME_FROM_ID;
  if (lastId > 0) {
    console.log(`[order_delivery] resuming from id > ${lastId}`);
  }

  while (lastId < maxId) {
    const rangeStart = lastId;
    const rangeEnd = lastId + BATCH_SIZE;

    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT id, \`${column}\` AS val FROM \`${table}\`
       WHERE id > ? AND id <= ?
         AND \`${column}\` IS NOT NULL AND \`${column}\` <> ''
       ORDER BY id ASC`,
      [rangeStart, rangeEnd],
    );

    for (const row of rows as Array<{ id: number; val: string }>) {
      const result = classify(row.val);
      if (result.kind === 'skip-empty' || result.kind === 'skip-already-ciphertext') {
        counters.skipped += 1;
        continue;
      }
      if (result.kind === 'ambiguous') {
        counters.ambiguous += 1;
        console.warn(`[ambiguous] ${table}.${column} id=${row.id} — 수동 검토 필요, 자동 UPDATE 하지 않음.`);
        continue;
      }

      if (DRY_RUN) {
        counters.updated += 1;
        continue;
      }

      try {
        const [res] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE \`${table}\` SET \`${column}\` = ? WHERE id = ? AND BINARY \`${column}\` = ?`,
          [result.ciphertext, row.id, row.val],
        );
        if (res.affectedRows === 1) {
          counters.updated += 1;
        } else {
          counters.skipped += 1;
        }
      } catch (err) {
        counters.failed += 1;
        console.error(`[failed] ${table}.${column} id=${row.id}: ${(err as Error).message}`);
      }
    }

    lastId = rangeEnd;
    console.log(
      `[order_delivery] checkpoint id<=${Math.min(lastId, maxId)}/${maxId} — ` +
        `updated=${counters.updated} skipped=${counters.skipped} failed=${counters.failed} ambiguous=${counters.ambiguous}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  validateOptions();
  console.log(`[options] batch-size=${BATCH_SIZE} resume-from-id=${RESUME_FROM_ID} run-id=${BACKFILL_RUN_ID}`);
  console.log(`[start] financial PII backfill — dry-run=${DRY_RUN} include-user-company=${INCLUDE_USER_COMPANY}`);
  if (DRY_RUN) {
    console.log('[dry-run] 아무 것도 쓰지 않습니다. 백업 스냅샷도 실제 생성하지 않고 계획만 출력합니다.');
  }

  const conn = await mysql.createConnection({
    host: requireEnv('DATABASE_HOST'),
    port: Number(process.env.DATABASE_PORT ?? 3306),
    user: requireEnv('DATABASE_USERNAME'),
    password: requireEnv('DATABASE_PASSWORD'),
    database: requireEnv('DATABASE_DATABASE'),
  });

  const totals = newCounters();

  try {
    const targets: Array<{ table: string; column: string }> = [
      { table: 'user', column: 'bank_number' },
      { table: 'user', column: 'card_number' },
      { table: 'partner_company', column: 'bank_number' },
    ];
    if (INCLUDE_USER_COMPANY) {
      targets.push({ table: 'user_company', column: 'bank_number' }, { table: 'user_company', column: 'card_number' });
    }

    for (const { table, column } of targets) {
      const before = { ...totals };
      await backfillSimpleTable(conn, table, column, totals);
      console.log(
        `[done] ${table}.${column} — updated=${totals.updated - before.updated} ` +
          `skipped=${totals.skipped - before.skipped} failed=${totals.failed - before.failed} ` +
          `ambiguous=${totals.ambiguous - before.ambiguous}`,
      );
    }

    await backfillOrderDelivery(conn, totals);

    console.log(
      `[result] updated=${totals.updated} skipped=${totals.skipped} failed=${totals.failed} ambiguous=${totals.ambiguous}` +
        (DRY_RUN ? ' (dry-run — 실제 UPDATE 없음)' : ''),
    );
    if (totals.ambiguous > 0) {
      console.warn(
        `[action-required] ambiguous ${totals.ambiguous}건 — 자동 처리되지 않았습니다. 개별 검수 후 수동 처리하세요.`,
      );
    }
    if (totals.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(`[fatal] ${(err as Error).message}`);
  process.exit(1);
});
