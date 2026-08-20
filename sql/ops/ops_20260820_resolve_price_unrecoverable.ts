/**
 * PRICE_UNRECOVERABLE remediation. All validation is fail-closed.
 *
 * Required environment binding for every mutation:
 * OPS_EXPECTED_API_ORIGIN, OPS_API_BASE, OPS_API_TOKEN,
 * OPS_EXPECTED_DB_HOST, OPS_EXPECTED_DB_NAME,
 * OPS_DB_HOST, OPS_DB_PORT, OPS_DB_USER, OPS_DB_PASS, OPS_DB_NAME,
 * OPS_APPROVED_MANIFEST_SHA256 (operator-approved dry-run digest).
 *
 * Commands:
 *   --dry-run
 *   OPS_APPROVED_MANIFEST_SHA256=<printed-digest> --propose --input=<manifest.json>
 *   OPS_APPROVED_MANIFEST_SHA256=<printed-digest> --approve --manifest=<manifest.json> --input=<propose-result.json>
 *   OPS_APPROVED_MANIFEST_SHA256=<printed-digest> --verify --manifest=<manifest.json> --input=<approve-result.json>
 *
 * The only ledger API read is paginated GET /settle/ledger/needs-review.
 * Resolution proposals have no GET route, so approval preflight is an exact
 * read from the separately bound database before any approve POST is sent.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as mysql from 'mysql2/promise';
import * as os from 'os';
import * as path from 'path';
import { calculateSettleAmounts } from '../../src/partner_settle/domain/settle.amount';
import { computeEvidenceHash, computePayloadHash } from '../../src/partner_settle/domain/proposal.hash';
import { IPriceAdjustment } from '../../src/user_discount/interface/price.adjustment';
import { IPartnerSettleVatCalculationMode } from '../../src/partner_settle/interface/partner.settle.source.type';

const EXPECTED_TOTAL = 563;
const EXPECTED_EXCHANGE = 314;
const EXPECTED_USAGE = 249;
const CONCURRENCY = 3;
const HTTP_TIMEOUT_MS = 30_000;
const OUTPUT_DIR = path.resolve(__dirname);
const RUN_ID = `run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
const OWNED_LOCKS: Array<{ file: string; token: string }> = [];

type Mode = 'dry-run' | 'propose' | 'approve' | 'verify';
type SourceType = 'EXCHANGE' | 'USAGE';

type EnvironmentBinding = {
  apiOrigin: string;
  dbHost: string;
  dbSchema: string;
};

type ManifestEntry = {
  ledgerId: number;
  sourceType: SourceType;
  baseAmount: string;
  evidenceRef: string;
  opmId: number;
  galaxiaBarcodeLogId: number | null;
  snapshotPrice: string | null;
  barcodeAmount: string | null;
};

type Manifest = {
  version: 2;
  runId: string;
  createdAt: string;
  binding: EnvironmentBinding;
  totalCount: number;
  exchangeCount: number;
  usageCount: number;
  sha256: string;
  entries: ManifestEntry[];
};

type ProposeResultEntry = {
  ledgerId: number;
  proposalId: number;
  status: 'OK' | 'FAILED';
  httpStatus?: number;
  error?: string;
};

type ProposeResult = {
  version: 2;
  runId: string;
  createdAt: string;
  manifestSha256: string;
  binding: EnvironmentBinding;
  results: ProposeResultEntry[];
};

type ApproveResultEntry = {
  ledgerId: number;
  proposalId: number;
  status: 'APPROVED' | 'FAILED';
  httpStatus?: number;
  error?: string;
};

type ApproveResult = {
  version: 2;
  runId: string;
  createdAt: string;
  manifestSha256: string;
  proposeRunId: string;
  binding: EnvironmentBinding;
  results: ApproveResultEntry[];
};

type Checkpoint = {
  version: 1;
  stage: 'propose' | 'approve';
  manifestSha256: string;
  binding: EnvironmentBinding;
  mappings: Record<string, number>;
};

type ApiConfig = { base: string; token: string };
type HttpResult = { status: number; data: unknown };
type StageLock = {
  stage: Checkpoint['stage'];
  manifestSha256: string;
  hostname: string;
  pid: number;
  token: string;
  createdAt: string;
};

function expectedEvidenceRef(entry: ManifestEntry): string {
  return `batch-resolve-price-unrecoverable:${entry.sourceType}:ledger-${entry.ledgerId}`;
}

function expectedReason(entry: ManifestEntry): string {
  return `OPM snapshot backfill; sourceType=${entry.sourceType}; amount=${entry.baseAmount}`;
}

function expectedRequestKey(entry: ManifestEntry): string {
  return `resolve-psl-${entry.ledgerId}-set-price-v2`;
}

function expectedApprovalReason(runId: string): string {
  return `batch approve PRICE_UNRECOVERABLE run=${runId}`;
}

function isApprovalReason(value: unknown): value is string {
  return typeof value === 'string' && /^batch approve PRICE_UNRECOVERABLE run=run-[0-9]+-[a-f0-9]{8}$/.test(value);
}

function expectedProposalPayload(entry: ManifestEntry): Record<string, unknown> {
  return {
    ledgerId: entry.ledgerId,
    reviewCode: 'PRICE_UNRECOVERABLE',
    resolutionMode: 'SET_PRICE',
    proposedValues: { baseAmount: entry.baseAmount, priceEvidenceRef: entry.evidenceRef },
    evidenceRef: expectedEvidenceRef(entry),
    reason: expectedReason(entry),
    requestKey: expectedRequestKey(entry),
  };
}

function fail(message: string): never {
  throw new Error(message);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) fail(`missing required environment variable ${name}`);
  return value;
}

function canonicalOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`invalid API origin: ${raw}`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    fail(`API origin must be a bare HTTPS origin: ${raw}`);
  }
  return parsed.origin;
}

function canonicalDbHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(host)) fail(`unsafe DB host: ${raw}`);
  return host;
}

function canonicalDbSchema(raw: string): string {
  const schema = raw.trim();
  if (!/^[A-Za-z0-9_]+$/.test(schema)) fail(`unsafe DB schema: ${raw}`);
  return schema;
}

function currentBinding(requireApi: boolean): EnvironmentBinding {
  const dbHost = canonicalDbHost(requireEnv('OPS_DB_HOST'));
  const dbSchema = canonicalDbSchema(requireEnv('OPS_DB_NAME'));
  if (dbHost !== canonicalDbHost(requireEnv('OPS_EXPECTED_DB_HOST'))) {
    fail('actual DB host does not equal expected DB host');
  }
  if (dbSchema !== canonicalDbSchema(requireEnv('OPS_EXPECTED_DB_NAME'))) {
    fail('actual DB schema does not equal expected DB schema');
  }

  const apiOrigin = canonicalOrigin(requireEnv('OPS_EXPECTED_API_ORIGIN'));
  if (requireApi && canonicalOrigin(requireEnv('OPS_API_BASE')) !== apiOrigin) {
    fail('actual API origin does not equal expected approved API origin');
  }
  return { apiOrigin, dbHost, dbSchema };
}

function sameBinding(left: EnvironmentBinding, right: EnvironmentBinding): boolean {
  return left.apiOrigin === right.apiOrigin && left.dbHost === right.dbHost && left.dbSchema === right.dbSchema;
}

function databaseConfig(): mysql.ConnectionOptions {
  return {
    host: requireEnv('OPS_DB_HOST'),
    port: Number(requireEnv('OPS_DB_PORT')),
    user: requireEnv('OPS_DB_USER'),
    password: requireEnv('OPS_DB_PASS'),
    database: requireEnv('OPS_DB_NAME'),
  };
}

function apiConfig(): ApiConfig {
  return { base: canonicalOrigin(requireEnv('OPS_API_BASE')), token: requireEnv('OPS_API_TOKEN') };
}

function canonicalPositiveInteger(value: unknown, label: string): string {
  const result = String(value);
  if (!/^[1-9][0-9]*$/.test(result)) fail(`${label} must be a canonical positive integer`);
  return result;
}

function canonicalSignedInteger(value: unknown, label: string): string {
  const result = String(value);
  if (!/^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(result)) fail(`${label} must be a canonical integer`);
  return result;
}

function safeId(value: unknown, label: string): number {
  const parsed = Number(canonicalPositiveInteger(value, label));
  if (!Number.isSafeInteger(parsed)) fail(`${label} exceeds JavaScript safe integer range`);
  return parsed;
}

function baseAmount(value: unknown, label: string): string {
  const result = canonicalPositiveInteger(value, label);
  if (BigInt(result) > 1_000_000_000n) fail(`${label} exceeds remediation maximum`);
  return result;
}

function artifactPositiveInteger(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a JSON string`);
  return canonicalPositiveInteger(value, label);
}

function artifactBaseAmount(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a JSON string`);
  return baseAmount(value, label);
}

function requireApprovedManifestHash(manifest: Manifest): void {
  const approved = requireEnv('OPS_APPROVED_MANIFEST_SHA256');
  if (!/^[a-f0-9]{64}$/.test(approved)) {
    fail('OPS_APPROVED_MANIFEST_SHA256 must be exactly 64 lowercase hexadecimal characters');
  }
  if (approved !== manifest.sha256) fail('approved manifest SHA256 does not match manifest');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function manifestHash(entries: ManifestEntry[], binding: EnvironmentBinding): string {
  return crypto.createHash('sha256').update(canonicalJson({ binding, entries })).digest('hex');
}

function writeAtomically(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, file);
}

function readArtifact<T>(file: string): T {
  if (!fs.existsSync(file)) fail(`artifact not found: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    fail(`invalid JSON artifact: ${file}`);
  }
}

function validateManifest(manifest: Manifest, binding: EnvironmentBinding): Manifest {
  if (manifest.version !== 2 || !sameBinding(manifest.binding, binding)) {
    fail('manifest version or environment binding mismatch');
  }
  if (
    !Array.isArray(manifest.entries) ||
    manifest.totalCount !== EXPECTED_TOTAL ||
    manifest.entries.length !== EXPECTED_TOTAL ||
    manifest.exchangeCount !== EXPECTED_EXCHANGE ||
    manifest.usageCount !== EXPECTED_USAGE
  ) {
    fail('manifest must contain exactly 563 entries: 314 EXCHANGE and 249 USAGE');
  }

  const ids = new Set<number>();
  let exchanges = 0;
  let usages = 0;
  for (const entry of manifest.entries) {
    const ledgerId = safeId(entry.ledgerId, 'ledgerId');
    if (ids.has(ledgerId)) fail(`duplicate ledgerId ${ledgerId}`);
    ids.add(ledgerId);
    safeId(entry.opmId, `opmId(${ledgerId})`);
    artifactBaseAmount(entry.baseAmount, `baseAmount(${ledgerId})`);
    if (typeof entry.evidenceRef !== 'string' || !entry.evidenceRef || entry.evidenceRef.length > 1000) {
      fail(`invalid evidenceRef for ledger ${ledgerId}`);
    }

    if (entry.sourceType === 'EXCHANGE') {
      if (entry.galaxiaBarcodeLogId !== null || artifactBaseAmount(entry.snapshotPrice, 'snapshotPrice') !== entry.baseAmount) {
        fail(`invalid EXCHANGE evidence for ledger ${ledgerId}`);
      }
      exchanges++;
    } else if (entry.sourceType === 'USAGE') {
      if (entry.galaxiaBarcodeLogId === null || artifactBaseAmount(entry.barcodeAmount, 'barcodeAmount') !== entry.baseAmount) {
        fail(`invalid USAGE evidence for ledger ${ledgerId}`);
      }
      safeId(entry.galaxiaBarcodeLogId, `galaxiaBarcodeLogId(${ledgerId})`);
      usages++;
    } else {
      fail(`invalid sourceType for ledger ${ledgerId}`);
    }
  }
  if (exchanges !== EXPECTED_EXCHANGE || usages !== EXPECTED_USAGE) fail('manifest source-type count mismatch');
  if (manifestHash(manifest.entries, manifest.binding) !== manifest.sha256) fail('manifest SHA256 mismatch');
  return manifest;
}

function checkpointPath(stage: Checkpoint['stage'], sha256: string): string {
  return path.join(OUTPUT_DIR, `${stage}-checkpoint-${sha256}.json`);
}

function acquireStageLock(stage: Checkpoint['stage'], manifest: Manifest): void {
  const file = path.join(OUTPUT_DIR, `${stage}-lock-${manifest.sha256}`);
  const owner: StageLock = {
    stage,
    manifestSha256: manifest.sha256,
    hostname: os.hostname(),
    pid: process.pid,
    token: crypto.randomBytes(16).toString('hex'),
    createdAt: new Date().toISOString(),
  };

  const create = (): void => {
    fs.writeFileSync(file, `${JSON.stringify(owner)}\n`, { flag: 'wx' });
    OWNED_LOCKS.push({ file, token: owner.token });
  };

  try {
    create();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

    let existing: StageLock;
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8')) as StageLock;
    } catch {
      fail(`${stage} lock metadata is malformed; refusing takeover`);
    }
    if (
      existing.stage !== stage ||
      existing.manifestSha256 !== manifest.sha256 ||
      typeof existing.hostname !== 'string' ||
      !Number.isSafeInteger(existing.pid) ||
      existing.pid < 1 ||
      !/^[a-f0-9]{32}$/.test(existing.token) ||
      typeof existing.createdAt !== 'string'
    ) {
      fail(`${stage} lock metadata is invalid; refusing takeover`);
    }
    if (existing.hostname !== owner.hostname) fail(`${stage} lock belongs to another host; refusing takeover`);

    let ownerIsDead = false;
    try {
      process.kill(existing.pid, 0);
    } catch (probeError: unknown) {
      ownerIsDead = (probeError as NodeJS.ErrnoException).code === 'ESRCH';
    }
    if (!ownerIsDead) fail(`${stage} lock owner PID is alive, reused, or indeterminate; refusing takeover`);

    const stale = `${file}.stale-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    try {
      fs.renameSync(file, stale);
    } catch {
      fail(`${stage} stale-lock rename raced or failed; refusing takeover`);
    }
    try {
      create();
    } catch {
      fail(`${stage} lock creation after stale takeover failed; refusing takeover`);
    }
  }
}

function releaseOwnedLocks(): void {
  for (const { file, token } of OWNED_LOCKS.splice(0)) {
    let owner: StageLock;
    try {
      owner = JSON.parse(fs.readFileSync(file, 'utf8')) as StageLock;
    } catch {
      fail(`owned lock is missing or malformed during cleanup: ${file}`);
    }
    if (owner.hostname !== os.hostname() || owner.pid !== process.pid || owner.token !== token) {
      fail(`owned lock ownership changed during cleanup: ${file}`);
    }
    fs.unlinkSync(file);
  }
}

function loadCheckpoint(stage: Checkpoint['stage'], manifest: Manifest, binding: EnvironmentBinding): Checkpoint {
  const file = checkpointPath(stage, manifest.sha256);
  if (!fs.existsSync(file)) {
    return { version: 1, stage, manifestSha256: manifest.sha256, binding, mappings: {} };
  }
  const checkpoint = readArtifact<Checkpoint>(file);
  if (
    checkpoint.version !== 1 ||
    checkpoint.stage !== stage ||
    checkpoint.manifestSha256 !== manifest.sha256 ||
    !sameBinding(checkpoint.binding, binding)
  ) {
    fail(`${stage} checkpoint binding mismatch`);
  }
  const manifestIds = new Set(manifest.entries.map((entry) => entry.ledgerId));
  const proposalIds = new Set<number>();
  for (const [ledgerId, proposalId] of Object.entries(checkpoint.mappings)) {
    const parsedLedgerId = safeId(ledgerId, 'checkpoint ledgerId');
    const parsedProposalId = safeId(proposalId, 'checkpoint proposalId');
    if (!manifestIds.has(parsedLedgerId) || proposalIds.has(parsedProposalId)) {
      fail(`${stage} checkpoint mappings are not a manifest subset bijection`);
    }
    proposalIds.add(parsedProposalId);
  }
  return checkpoint;
}

function saveCheckpoint(stage: Checkpoint['stage'], manifest: Manifest, checkpoint: Checkpoint): void {
  writeAtomically(checkpointPath(stage, manifest.sha256), checkpoint);
}

async function httpGet(url: string, token: string): Promise<HttpResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    return { status: response.status, data: await response.json().catch(() => null) };
  } finally {
    clearTimeout(timeout);
  }
}

async function httpPost(url: string, body: unknown, token: string): Promise<HttpResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  } finally {
    clearTimeout(timeout);
  }
}

async function limited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

async function preflightLedgers(manifest: Manifest, binding: EnvironmentBinding, api: ApiConfig): Promise<void> {
  if (!sameBinding(manifest.binding, binding)) fail('manifest binding mismatch before ledger preflight');
  const serverLedgers = new Map<number, Record<string, unknown>>();
  let cursor: string | null = null;
  do {
    const url = new URL(`${api.base}/settle/ledger/needs-review`);
    url.searchParams.set('source', 'LEDGER');
    url.searchParams.set('status', 'NEEDS_REVIEW');
    url.searchParams.set('reviewCode', 'PRICE_UNRECOVERABLE');
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);

    const response = await httpGet(url.toString(), api.token);
    if (response.status !== 200 || !response.data || typeof response.data !== 'object') {
      fail(`ledger preflight GET failed: HTTP ${response.status}`);
    }
    const page = response.data as { items?: unknown; nextCursor?: unknown };
    if (!Array.isArray(page.items) || !(page.nextCursor === null || typeof page.nextCursor === 'string')) {
      fail('malformed ledger preflight response');
    }
    for (const item of page.items) {
      if (!item || typeof item !== 'object') fail('malformed ledger preflight item');
      const ledger = item as Record<string, unknown>;
      const ledgerId = safeId(ledger.id, 'server ledger id');
      if (serverLedgers.has(ledgerId)) fail(`duplicate server ledger ${ledgerId}`);
      serverLedgers.set(ledgerId, ledger);
    }
    cursor = page.nextCursor as string | null;
  } while (cursor);

  if (serverLedgers.size !== EXPECTED_TOTAL) {
    fail(`ledger preflight returned ${serverLedgers.size}, expected ${EXPECTED_TOTAL}`);
  }
  for (const entry of manifest.entries) {
    const ledger = serverLedgers.get(entry.ledgerId);
    if (
      !ledger ||
      ledger.source !== 'LEDGER' ||
      ledger.status !== 'NEEDS_REVIEW' ||
      ledger.reviewCode !== 'PRICE_UNRECOVERABLE' ||
      ledger.baseAmount !== null
    ) {
      fail(`server ledger preflight mismatch for ${entry.ledgerId}`);
    }
  }
}

function validateProposeResult(result: ProposeResult, manifest: Manifest, binding: EnvironmentBinding): Map<number, number> {
  if (
    result.version !== 2 ||
    result.manifestSha256 !== manifest.sha256 ||
    !sameBinding(result.binding, binding) ||
    !Array.isArray(result.results) ||
    result.results.length !== EXPECTED_TOTAL
  ) fail('propose artifact binding/count mismatch');

  const mappings = new Map<number, number>();
  const proposalIds = new Set<number>();
  const manifestIds = new Set(manifest.entries.map((entry) => entry.ledgerId));
  for (const item of result.results) {
    const ledgerId = safeId(item.ledgerId, 'propose ledgerId');
    const proposalId = safeId(item.proposalId, 'proposalId');
    if (item.status !== 'OK' || !manifestIds.has(ledgerId) || mappings.has(ledgerId) || proposalIds.has(proposalId)) {
      fail('propose artifact must be a bijection of the manifest');
    }
    mappings.set(ledgerId, proposalId);
    proposalIds.add(proposalId);
  }
  if (mappings.size !== EXPECTED_TOTAL) fail('propose artifact exact set mismatch');
  return mappings;
}

async function preflightProposals(
  manifest: Manifest,
  mappings: Map<number, number>,
  binding: EnvironmentBinding,
  approvedCheckpoint?: Checkpoint,
): Promise<void> {
  if (!sameBinding(manifest.binding, binding)) fail('manifest binding mismatch before proposal DB preflight');
  const connection = await mysql.createConnection(databaseConfig());
  try {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT CAST(r.id AS CHAR) proposalId, CAST(r.ledger_id AS CHAR) ledgerId, r.status,
              r.review_code reviewCode, r.resolution_mode resolutionMode,
              CAST(JSON_UNQUOTE(JSON_EXTRACT(r.proposed_values, '$.baseAmount')) AS CHAR) baseAmount,
              JSON_UNQUOTE(JSON_EXTRACT(r.proposed_values, '$.priceEvidenceRef')) priceEvidenceRef,
              r.evidence_ref evidenceRef, r.evidence_hash evidenceHash, r.request_key requestKey,
              r.payload_hash payloadHash, r.payload_hash_version payloadHashVersion, r.decision_reason decisionReason,
              JSON_LENGTH(r.proposed_values) proposedValuesKeyCount,
              CAST(r.proposed_by AS CHAR) proposedBy, CAST(r.decided_by AS CHAR) decidedBy,
              CAST(a.resolution_id AS CHAR) auditResolutionId, CAST(a.ledger_id AS CHAR) auditLedgerId,
              CAST(a.actor_id AS CHAR) auditActorId,
              a.provider_evidence_ref auditProviderEvidenceRef, a.provider_evidence_hash auditProviderEvidenceHash,
              a.price_evidence_ref auditPriceEvidenceRef, a.reason auditReason,
              a.before_status auditBeforeStatus, a.before_review_code auditBeforeReviewCode,
              a.before_review_resolution auditBeforeReviewResolution,
              CAST(a.before_base_amount AS CHAR) auditBeforeBaseAmount,
              CAST(a.before_applied_price_percent AS CHAR) auditBeforeAppliedPricePercent,
              a.before_applied_price_adjustment auditBeforeAppliedPriceAdjustment,
              CAST(a.before_settle_amount AS CHAR) auditBeforeSettleAmount,
              a.before_pricing_resolution auditBeforePricingResolution,
              a.after_status auditAfterStatus, a.after_review_code auditAfterReviewCode,
              a.after_review_resolution auditAfterReviewResolution,
              CAST(a.after_base_amount AS CHAR) auditAfterBaseAmount,
              CAST(a.after_applied_price_percent AS CHAR) auditAfterAppliedPricePercent,
              a.after_applied_price_adjustment auditAfterAppliedPriceAdjustment,
              CAST(a.after_settle_amount AS CHAR) auditAfterSettleAmount,
              a.after_pricing_resolution auditAfterPricingResolution,
              l.status ledgerStatus, l.review_code ledgerReviewCode, l.review_resolution ledgerReviewResolution,
              CAST(l.base_amount AS CHAR) ledgerBaseAmount,
              CAST(l.applied_price_percent AS CHAR) ledgerAppliedPricePercent,
              l.applied_price_adjustment ledgerAppliedPriceAdjustment,
              CAST(l.settle_amount AS CHAR) ledgerSettleAmount,
              l.pricing_resolution ledgerPricingResolution
         FROM partner_settle_review_resolution r
         LEFT JOIN partner_settle_review_audit a ON a.resolution_id = r.id AND a.ledger_id = r.ledger_id
         LEFT JOIN partner_settle_ledger l ON l.id = r.ledger_id
        WHERE r.id IN (?)`,
      [[...mappings.values()]],
    );
    if (rows.length !== mappings.size) fail(`proposal DB preflight returned ${rows.length}, expected ${mappings.size}`);

    const seen = new Set<number>();
    for (const row of rows) {
      const proposalId = safeId(row.proposalId, 'proposalId');
      const ledgerId = safeId(row.ledgerId, 'proposal ledgerId');
      const entry = manifest.entries.find((candidate) => candidate.ledgerId === ledgerId);
      const checkpointProposalId = approvedCheckpoint?.mappings[String(ledgerId)];
      const recoveredApproval = row.status === 'APPROVED';
      if (
        !entry || seen.has(proposalId) || mappings.get(ledgerId) !== proposalId ||
        checkpointProposalId !== undefined && checkpointProposalId !== proposalId ||
        (row.status !== 'PENDING' && !recoveredApproval) ||
        (checkpointProposalId !== undefined && !recoveredApproval) ||
        row.reviewCode !== 'PRICE_UNRECOVERABLE' || row.resolutionMode !== 'SET_PRICE' ||
        baseAmount(row.baseAmount, `proposal baseAmount(${proposalId})`) !== entry.baseAmount ||
        row.priceEvidenceRef !== entry.evidenceRef ||
        row.evidenceRef !== expectedEvidenceRef(entry) ||
        row.evidenceHash !== computeEvidenceHash(expectedEvidenceRef(entry)) ||
        row.requestKey !== expectedRequestKey(entry) ||
        row.payloadHashVersion !== 'v1' ||
        row.payloadHash !== computePayloadHash(expectedProposalPayload(entry), 'v1') ||
        Number(row.proposedValuesKeyCount) !== 2 ||
        (!recoveredApproval
          ? (row.decisionReason !== expectedReason(entry) || row.decidedBy !== null || row.auditResolutionId !== null)
          : (
            safeId(row.proposedBy, `proposedBy(${proposalId})`) === safeId(row.decidedBy, `decidedBy(${proposalId})`) ||
            safeId(row.auditResolutionId, `auditResolutionId(${proposalId})`) !== proposalId ||
            safeId(row.auditLedgerId, `auditLedgerId(${proposalId})`) !== ledgerId ||
            !isApprovalReason(row.decisionReason) ||
            row.auditReason !== row.decisionReason ||
            safeId(row.auditActorId, `auditActorId(${proposalId})`) !== safeId(row.decidedBy, `decidedBy(${proposalId})`) ||
            row.auditProviderEvidenceRef !== row.evidenceRef ||
            row.auditProviderEvidenceHash !== row.evidenceHash ||
            row.auditPriceEvidenceRef !== entry.evidenceRef ||
            row.auditBeforeStatus !== 'NEEDS_REVIEW' ||
            row.auditBeforeReviewCode !== 'PRICE_UNRECOVERABLE' ||
            row.auditBeforeReviewResolution !== 'PENDING' ||
            row.auditBeforeBaseAmount !== null ||
            row.auditBeforeAppliedPricePercent !== null ||
            row.auditBeforeAppliedPriceAdjustment !== null ||
            row.auditBeforeSettleAmount !== null ||
            row.auditBeforePricingResolution !== null ||
            row.auditAfterStatus !== 'NORMAL' ||
            row.auditAfterReviewCode !== null ||
            row.auditAfterReviewResolution !== null ||
            row.auditAfterBaseAmount !== row.ledgerBaseAmount ||
            row.auditAfterAppliedPricePercent !== row.ledgerAppliedPricePercent ||
            row.auditAfterAppliedPriceAdjustment !== row.ledgerAppliedPriceAdjustment ||
            row.auditAfterSettleAmount !== row.ledgerSettleAmount ||
            row.auditAfterPricingResolution !== row.ledgerPricingResolution ||
            row.ledgerStatus !== 'NORMAL' || row.ledgerReviewCode !== null || row.ledgerReviewResolution !== null
          ))
      ) fail(`proposal DB preflight mismatch for ${proposalId}`);
      if (recoveredApproval && approvedCheckpoint && checkpointProposalId === undefined) {
        approvedCheckpoint.mappings[String(ledgerId)] = proposalId;
        saveCheckpoint('approve', manifest, approvedCheckpoint);
      }
      seen.add(proposalId);
    }
  } finally {
    await connection.end();
  }
}

async function preflightSourceEvidence(manifest: Manifest, approvedCheckpoint?: Checkpoint): Promise<void> {
  const connection = await mysql.createConnection(databaseConfig());
  try {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT CAST(psl.id AS CHAR) ledgerId, psl.source_type sourceType, psl.status, psl.review_code reviewCode,
              CAST(psl.base_amount AS CHAR) ledgerBaseAmount,
              CAST(psl.galaxia_barcode_log_id AS CHAR) galaxiaBarcodeLogId,
              CAST(od.order_product_mapping_id AS CHAR) opmId,
              CAST(opm.snapshot_product_price AS CHAR) snapshotPrice,
              CAST(gbl.amount AS CHAR) barcodeAmount
         FROM partner_settle_ledger psl
         LEFT JOIN order_delivery od ON od.id = psl.order_delivery_id
         LEFT JOIN order_product_mapping opm ON opm.id = od.order_product_mapping_id
         LEFT JOIN galaxia_barcode_log gbl ON gbl.id = psl.galaxia_barcode_log_id
        WHERE psl.id IN (?)`,
      [manifest.entries.map((entry) => entry.ledgerId)],
    );
    if (rows.length !== EXPECTED_TOTAL) fail(`source evidence preflight returned ${rows.length}, expected ${EXPECTED_TOTAL}`);
    const seen = new Set<number>();
    for (const row of rows) {
      const ledgerId = safeId(row.ledgerId, 'source ledgerId');
      const entry = manifest.entries.find((candidate) => candidate.ledgerId === ledgerId);
      const recovered = approvedCheckpoint?.mappings[String(ledgerId)] !== undefined;
      if (!entry || seen.has(ledgerId) || row.sourceType !== entry.sourceType ||
          (!recovered && (row.status !== 'NEEDS_REVIEW' || row.reviewCode !== 'PRICE_UNRECOVERABLE' || row.ledgerBaseAmount !== null)) ||
          safeId(row.opmId, `source opmId(${ledgerId})`) !== entry.opmId) {
        fail(`source evidence identity mismatch for ${ledgerId}`);
      }
      if (entry.sourceType === 'EXCHANGE') {
        if (row.galaxiaBarcodeLogId !== null || artifactBaseAmount(row.snapshotPrice, `source snapshotPrice(${ledgerId})`) !== entry.baseAmount ||
            entry.evidenceRef !== `opm:${entry.opmId}:snapshot_product_price:ops_20260820`) {
          fail(`source EXCHANGE evidence mismatch for ${ledgerId}`);
        }
      } else if (
        safeId(row.galaxiaBarcodeLogId, `source galaxiaBarcodeLogId(${ledgerId})`) !== entry.galaxiaBarcodeLogId ||
        artifactBaseAmount(row.barcodeAmount, `source barcodeAmount(${ledgerId})`) !== entry.baseAmount ||
        entry.evidenceRef !== `galaxia_barcode_log:${entry.galaxiaBarcodeLogId}:amount`
      ) {
        fail(`source USAGE evidence mismatch for ${ledgerId}`);
      }
      seen.add(ledgerId);
    }
  } finally {
    await connection.end();
  }
}

async function runDryRun(): Promise<void> {
  const binding = currentBinding(false);
  const connection = await mysql.createConnection(databaseConfig());
  try {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT CAST(psl.id AS CHAR) ledgerId, psl.source_type sourceType,
              CAST(psl.galaxia_barcode_log_id AS CHAR) galaxiaBarcodeLogId,
              CAST(od.order_product_mapping_id AS CHAR) opmId,
              CAST(opm.snapshot_product_price AS CHAR) snapshotPrice,
              CAST(gbl.amount AS CHAR) barcodeAmount
         FROM partner_settle_ledger psl
         LEFT JOIN order_delivery od ON od.id = psl.order_delivery_id
         LEFT JOIN order_product_mapping opm ON opm.id = od.order_product_mapping_id
         LEFT JOIN galaxia_barcode_log gbl ON gbl.id = psl.galaxia_barcode_log_id
        WHERE psl.status = 'NEEDS_REVIEW' AND psl.review_code = 'PRICE_UNRECOVERABLE'
        ORDER BY psl.source_type, psl.id`,
    );
    const entries = rows.map((row): ManifestEntry => {
      const ledgerId = safeId(row.ledgerId, 'ledgerId');
      const opmId = safeId(row.opmId, `opmId(${ledgerId})`);
      if (row.sourceType === 'EXCHANGE') {
        const value = baseAmount(row.snapshotPrice, `snapshotPrice(${ledgerId})`);
        return { ledgerId, sourceType: 'EXCHANGE', baseAmount: value, evidenceRef: `opm:${opmId}:snapshot_product_price:ops_20260820`, opmId, galaxiaBarcodeLogId: null, snapshotPrice: value, barcodeAmount: null };
      }
      if (row.sourceType === 'USAGE') {
        const barcodeLogId = safeId(row.galaxiaBarcodeLogId, `galaxiaBarcodeLogId(${ledgerId})`);
        const value = baseAmount(row.barcodeAmount, `barcodeAmount(${ledgerId})`);
        return { ledgerId, sourceType: 'USAGE', baseAmount: value, evidenceRef: `galaxia_barcode_log:${barcodeLogId}:amount`, opmId, galaxiaBarcodeLogId: barcodeLogId, snapshotPrice: null, barcodeAmount: value };
      }
      fail(`unexpected source type for ledger ${ledgerId}`);
    });
    const manifest: Manifest = {
      version: 2, runId: RUN_ID, createdAt: new Date().toISOString(), binding,
      totalCount: entries.length,
      exchangeCount: entries.filter((entry) => entry.sourceType === 'EXCHANGE').length,
      usageCount: entries.filter((entry) => entry.sourceType === 'USAGE').length,
      sha256: manifestHash(entries, binding), entries,
    };
    validateManifest(manifest, binding);
    const output = path.join(OUTPUT_DIR, `manifest-${RUN_ID}.json`);
    writeAtomically(output, manifest);
    console.log(`manifest written: ${output}`);
    console.log(`operator approval required: OPS_APPROVED_MANIFEST_SHA256=${manifest.sha256}`);
  } finally {
    await connection.end();
  }
}

async function runPropose(input: string): Promise<void> {
  const binding = currentBinding(true);
  const manifest = validateManifest(readArtifact<Manifest>(path.resolve(input)), binding);
  requireApprovedManifestHash(manifest);
  acquireStageLock('propose', manifest);
  await preflightSourceEvidence(manifest);
  const api = apiConfig();
  const checkpoint = loadCheckpoint('propose', manifest, binding);
  const resumedMappings = new Map<number, number>(
    Object.entries(checkpoint.mappings).map(([ledgerId, proposalId]) => [safeId(ledgerId, 'checkpoint ledgerId'), proposalId]),
  );
  if (resumedMappings.size > 0) await preflightProposals(manifest, resumedMappings, binding);
  await preflightLedgers(manifest, binding, api);

  const results = await limited(manifest.entries, async (entry): Promise<ProposeResultEntry> => {
    const prior = checkpoint.mappings[String(entry.ledgerId)];
    if (prior) return { ledgerId: entry.ledgerId, proposalId: prior, status: 'OK' };
    const body = {
      ledgerId: entry.ledgerId, reviewCode: 'PRICE_UNRECOVERABLE', resolutionMode: 'SET_PRICE',
      proposedValues: { baseAmount: entry.baseAmount, priceEvidenceRef: entry.evidenceRef },
      evidenceRef: `batch-resolve-price-unrecoverable:${entry.sourceType}:ledger-${entry.ledgerId}`,
      reason: `OPM snapshot backfill; sourceType=${entry.sourceType}; amount=${entry.baseAmount}`,
      requestKey: `resolve-psl-${entry.ledgerId}-set-price-v2`,
    };
    try {
      const response = await httpPost(`${api.base}/settle/ledger/needs-review/resolve/propose`, body, api.token);
      if (response.status < 200 || response.status >= 300) return { ledgerId: entry.ledgerId, proposalId: 0, status: 'FAILED', httpStatus: response.status, error: 'non-2xx propose' };
      const proposalId = safeId((response.data as { proposal?: { id?: unknown } })?.proposal?.id, 'proposalId');
      checkpoint.mappings[String(entry.ledgerId)] = proposalId;
      saveCheckpoint('propose', manifest, checkpoint);
      return { ledgerId: entry.ledgerId, proposalId, status: 'OK', httpStatus: response.status };
    } catch (error) {
      return { ledgerId: entry.ledgerId, proposalId: 0, status: 'FAILED', error: (error as Error).message };
    }
  });
  const artifact: ProposeResult = { version: 2, runId: RUN_ID, createdAt: new Date().toISOString(), manifestSha256: manifest.sha256, binding, results };
  writeAtomically(path.join(OUTPUT_DIR, `propose-result-${RUN_ID}.json`), artifact);
  if (results.some((result) => result.status !== 'OK')) fail('propose contains failures; approve blocked');
}

async function runApprove(manifestPath: string, input: string): Promise<void> {
  const binding = currentBinding(true);
  const manifest = validateManifest(readArtifact<Manifest>(path.resolve(manifestPath)), binding);
  requireApprovedManifestHash(manifest);
  acquireStageLock('approve', manifest);
  const propose = readArtifact<ProposeResult>(path.resolve(input));
  const mappings = validateProposeResult(propose, manifest, binding);
  const api = apiConfig();
  const checkpoint = loadCheckpoint('approve', manifest, binding);
  await preflightProposals(manifest, mappings, binding, checkpoint);
  await preflightSourceEvidence(manifest, checkpoint);

  const results = await limited(manifest.entries, async (entry): Promise<ApproveResultEntry> => {
    const proposalId = mappings.get(entry.ledgerId)!;
    const prior = checkpoint.mappings[String(entry.ledgerId)];
    if (prior !== undefined) {
      if (prior !== proposalId) fail(`approve checkpoint mapping mismatch for ${entry.ledgerId}`);
      return { ledgerId: entry.ledgerId, proposalId, status: 'APPROVED' };
    }
    try {
      const response = await httpPost(`${api.base}/settle/ledger/needs-review/resolve/${proposalId}/approve`, { decisionReason: `batch approve PRICE_UNRECOVERABLE run=${RUN_ID}` }, api.token);
      if (response.status < 200 || response.status >= 300) return { ledgerId: entry.ledgerId, proposalId, status: 'FAILED', httpStatus: response.status, error: 'non-2xx approve' };
      checkpoint.mappings[String(entry.ledgerId)] = proposalId;
      saveCheckpoint('approve', manifest, checkpoint);
      return { ledgerId: entry.ledgerId, proposalId, status: 'APPROVED', httpStatus: response.status };
    } catch (error) {
      return { ledgerId: entry.ledgerId, proposalId, status: 'FAILED', error: (error as Error).message };
    }
  });
  const artifact: ApproveResult = { version: 2, runId: RUN_ID, createdAt: new Date().toISOString(), manifestSha256: manifest.sha256, proposeRunId: propose.runId, binding, results };
  writeAtomically(path.join(OUTPUT_DIR, `approve-result-${RUN_ID}.json`), artifact);
  if (results.some((result) => result.status !== 'APPROVED')) fail('approve contains failures');
}

async function runVerify(manifestPath: string, input: string): Promise<void> {
  const binding = currentBinding(true);
  const manifest = validateManifest(readArtifact<Manifest>(path.resolve(manifestPath)), binding);
  requireApprovedManifestHash(manifest);
  const approval = readArtifact<ApproveResult>(path.resolve(input));
  if (approval.version !== 2 || approval.manifestSha256 !== manifest.sha256 || !sameBinding(approval.binding, binding) || approval.results.length !== EXPECTED_TOTAL) fail('approve artifact binding/count mismatch');

  const approved = new Map<number, number>();
  const approvedProposalIds = new Set<number>();
  const manifestLedgerIds = new Set(manifest.entries.map((entry) => entry.ledgerId));
  for (const item of approval.results) {
    const ledgerId = safeId(item.ledgerId, 'approved ledgerId');
    const proposalId = safeId(item.proposalId, 'approved proposalId');
    if (
      item.status !== 'APPROVED' ||
      !manifestLedgerIds.has(ledgerId) ||
      approved.has(ledgerId) ||
      approvedProposalIds.has(proposalId)
    ) {
      fail('invalid approve artifact');
    }
    approved.set(ledgerId, proposalId);
    approvedProposalIds.add(proposalId);
  }
  if (approved.size !== EXPECTED_TOTAL || approvedProposalIds.size !== EXPECTED_TOTAL) {
    fail('approve artifact exact target set mismatch');
  }

  const connection = await mysql.createConnection(databaseConfig());
  try {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT CAST(l.id AS CHAR) ledgerId, l.status, l.review_code reviewCode, l.review_resolution reviewResolution,
              CAST(l.base_amount AS CHAR) baseAmount, CAST(l.discount_amount AS CHAR) discountAmount,
              CAST(l.applied_price_percent AS CHAR) appliedPricePercent, l.applied_price_adjustment appliedPriceAdjustment,
              l.vat_calculation_mode vatCalculationMode, CAST(l.receiving_commission_amount AS CHAR) receivingCommissionAmount,
              CAST(l.giving_commission_amount AS CHAR) givingCommissionAmount, CAST(l.vat_amount AS CHAR) vatAmount,
              CAST(l.fee_total_amount AS CHAR) feeTotalAmount, CAST(l.settle_amount AS CHAR) settleAmount,
              l.pricing_resolution pricingResolution,
              CAST(p.id AS CHAR) proposalId, p.status proposalStatus, CAST(p.proposed_by AS CHAR) proposedBy,
              CAST(p.decided_by AS CHAR) decidedBy, p.resolution_mode resolutionMode, p.review_code proposalReviewCode,
              CAST(JSON_UNQUOTE(JSON_EXTRACT(p.proposed_values, '$.baseAmount')) AS CHAR) proposalBaseAmount,
              JSON_UNQUOTE(JSON_EXTRACT(p.proposed_values, '$.priceEvidenceRef')) priceEvidenceRef,
              p.evidence_ref evidenceRef, p.evidence_hash evidenceHash, p.request_key requestKey,
              p.payload_hash payloadHash, p.payload_hash_version payloadHashVersion, p.decision_reason decisionReason,
              JSON_LENGTH(p.proposed_values) proposedValuesKeyCount,
              CAST(a.resolution_id AS CHAR) auditResolutionId, CAST(a.ledger_id AS CHAR) auditLedgerId,
              CAST(a.actor_id AS CHAR) auditActorId,
              a.provider_evidence_ref auditProviderEvidenceRef, a.provider_evidence_hash auditProviderEvidenceHash,
              a.price_evidence_ref auditPriceEvidenceRef, a.reason auditReason,
              a.before_status auditBeforeStatus, a.before_review_code auditBeforeReviewCode,
              a.before_review_resolution auditBeforeReviewResolution,
              CAST(a.before_base_amount AS CHAR) auditBeforeBaseAmount,
              CAST(a.before_applied_price_percent AS CHAR) auditBeforeAppliedPricePercent,
              a.before_applied_price_adjustment auditBeforeAppliedPriceAdjustment,
              CAST(a.before_settle_amount AS CHAR) auditBeforeSettleAmount,
              a.before_pricing_resolution auditBeforePricingResolution,
              a.after_status auditAfterStatus, a.after_review_code auditAfterReviewCode,
              a.after_review_resolution auditAfterReviewResolution,
              CAST(a.after_base_amount AS CHAR) auditAfterBaseAmount,
              CAST(a.after_applied_price_percent AS CHAR) auditAfterAppliedPricePercent,
              a.after_applied_price_adjustment auditAfterAppliedPriceAdjustment,
              CAST(a.after_settle_amount AS CHAR) auditAfterSettleAmount,
              a.after_pricing_resolution auditAfterPricingResolution
         FROM partner_settle_ledger l
         JOIN partner_settle_review_audit a ON a.ledger_id = l.id
         JOIN partner_settle_review_resolution p ON p.id = a.resolution_id AND p.ledger_id = l.id
        WHERE l.id IN (?) AND a.resolution_id IN (?)`,
      [manifest.entries.map((entry) => entry.ledgerId), [...approvedProposalIds]],
    );
    if (rows.length !== EXPECTED_TOTAL) fail(`verification returned ${rows.length}, expected ${EXPECTED_TOTAL}`);

    const verified = new Set<number>();
    for (const row of rows) {
      const ledgerId = safeId(row.ledgerId, 'verified ledgerId');
      const proposalId = safeId(row.proposalId, 'verified proposalId');
      const entry = manifest.entries.find((candidate) => candidate.ledgerId === ledgerId);
      if (!entry || verified.has(ledgerId) || approved.get(ledgerId) !== proposalId) {
        fail(`verification target/mapping mismatch for ${ledgerId}`);
      }
      verified.add(ledgerId);
      if (
        row.status !== 'NORMAL' ||
        row.reviewCode !== null ||
        row.reviewResolution !== null ||
        row.proposalStatus !== 'APPROVED' ||
        row.resolutionMode !== 'SET_PRICE' ||
        row.proposalReviewCode !== 'PRICE_UNRECOVERABLE' ||
        baseAmount(row.baseAmount, 'ledger baseAmount') !== entry.baseAmount ||
        baseAmount(row.proposalBaseAmount, 'proposal baseAmount') !== entry.baseAmount ||
        row.priceEvidenceRef !== entry.evidenceRef ||
        row.evidenceRef !== expectedEvidenceRef(entry) ||
        row.evidenceHash !== computeEvidenceHash(expectedEvidenceRef(entry)) ||
        row.requestKey !== expectedRequestKey(entry) ||
        row.payloadHashVersion !== 'v1' ||
        row.payloadHash !== computePayloadHash(expectedProposalPayload(entry), 'v1') ||
        Number(row.proposedValuesKeyCount) !== 2 ||
        !isApprovalReason(row.decisionReason) ||
        row.auditReason !== row.decisionReason ||
        safeId(row.proposedBy, 'proposedBy') === safeId(row.decidedBy, 'decidedBy') ||
        safeId(row.auditResolutionId, 'audit resolutionId') !== proposalId ||
        safeId(row.auditLedgerId, 'audit ledgerId') !== ledgerId ||
        safeId(row.auditActorId, 'audit actorId') !== safeId(row.decidedBy, 'decidedBy') ||
        row.auditProviderEvidenceRef !== row.evidenceRef ||
        row.auditProviderEvidenceHash !== row.evidenceHash ||
        row.auditPriceEvidenceRef !== entry.evidenceRef ||
        row.auditBeforeStatus !== 'NEEDS_REVIEW' ||
        row.auditBeforeReviewCode !== 'PRICE_UNRECOVERABLE' ||
        row.auditBeforeReviewResolution !== 'PENDING' ||
        row.auditBeforeBaseAmount !== null ||
        row.auditBeforeAppliedPricePercent !== null ||
        row.auditBeforeAppliedPriceAdjustment !== null ||
        row.auditBeforeSettleAmount !== null ||
        row.auditBeforePricingResolution !== null ||
        row.auditAfterStatus !== 'NORMAL' ||
        row.auditAfterReviewCode !== null ||
        row.auditAfterReviewResolution !== null ||
        row.auditAfterBaseAmount !== row.baseAmount ||
        row.auditAfterAppliedPricePercent !== row.appliedPricePercent ||
        row.auditAfterAppliedPriceAdjustment !== row.appliedPriceAdjustment ||
        row.auditAfterSettleAmount !== row.settleAmount ||
        row.auditAfterPricingResolution !== row.pricingResolution
      ) {
        fail(`verification metadata mismatch for ${ledgerId}`);
      }

      if (row.appliedPriceAdjustment !== IPriceAdjustment.DISCOUNT && row.appliedPriceAdjustment !== IPriceAdjustment.ADDITIONAL) {
        fail(`invalid appliedPriceAdjustment for ${ledgerId}`);
      }
      if (!['SEPARATE_ROUND', 'INCLUDED_REMAINDER', 'NONE'].includes(String(row.vatCalculationMode))) {
        fail(`invalid vatCalculationMode for ${ledgerId}`);
      }

      const calculated = calculateSettleAmounts({
        baseAmount: BigInt(entry.baseAmount),
        discountAmount: BigInt(canonicalSignedInteger(row.discountAmount, `discountAmount(${ledgerId})`)),
        pricePercent: String(row.appliedPricePercent),
        priceAdjustment: row.appliedPriceAdjustment as IPriceAdjustment,
        vatCalculationMode: row.vatCalculationMode as IPartnerSettleVatCalculationMode,
      });
      const expected = {
        baseAmount: String(calculated.baseAmount),
        receivingCommissionAmount: String(calculated.receivingCommissionAmount),
        givingCommissionAmount: String(calculated.givingCommissionAmount),
        vatAmount: String(calculated.vatAmount),
        feeTotalAmount: String(calculated.feeTotalAmount),
        settleAmount: String(calculated.settleAmount),
      };
      for (const [field, value] of Object.entries(expected)) {
        if (canonicalSignedInteger(row[field], `${field}(${ledgerId})`) !== value) {
          fail(`verification calculated ${field} mismatch for ${ledgerId}`);
        }
      }
    }
    if (verified.size !== EXPECTED_TOTAL) fail('verification exact target set mismatch');
    console.log(`verification passed: ${verified.size} exact proposal-specific ledgers`);
  } finally {
    await connection.end();
  }
}

function parseArgs(): { mode: Mode; input: string; manifest: string } {
  const flags = new Map<string, string>();
  for (const argument of process.argv.slice(2)) {
    if (!argument.startsWith('--')) continue;
    const separator = argument.indexOf('=');
    flags.set(argument.slice(2, separator < 0 ? undefined : separator), separator < 0 ? 'true' : argument.slice(separator + 1));
  }
  const modes = (['dry-run', 'propose', 'approve', 'verify'] as Mode[]).filter((mode) => flags.has(mode));
  if (modes.length !== 1 || flags.has('token')) fail('select exactly one mode; --token is forbidden');
  const mode = modes[0];
  const input = flags.get('input') ?? '';
  const manifest = flags.get('manifest') ?? '';
  if ((mode === 'propose' && !input) || ((mode === 'approve' || mode === 'verify') && (!input || !manifest))) fail('propose requires --input; approve/verify require --manifest and --input');
  return { mode, input, manifest };
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.mode === 'dry-run') await runDryRun();
  else if (args.mode === 'propose') await runPropose(args.input);
  else if (args.mode === 'approve') await runApprove(args.manifest, args.input);
  else await runVerify(args.manifest, args.input);
}

main()
  .catch((error) => {
    console.error(`FATAL: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    releaseOwnedLocks();
  });
