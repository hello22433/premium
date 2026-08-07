import { createHash } from 'crypto';

/**
 * canonical payload hash (정본 §5 128·139행).
 *
 * 입력 객체를 RFC 8785 JCS(JSON Canonicalization Scheme) 간이 구현으로 직렬화한 뒤
 * SHA-256 hex를 반환한다. version prefix를 붙여 향후 canonicalization 변경에 대비한다.
 *
 * JCS 간이: 키 유니코드 코드포인트 순 정렬, undefined/function 제외, Date→ISO string.
 * 이 프로젝트에서는 proposal payload가 단순 flat/shallow이므로 충분하다.
 */
export function computePayloadHash(fields: Record<string, unknown>, version: string = 'v1'): string {
  const canonical = canonicalizeJson(fields);
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `${version}:${hash}`;
}

/**
 * assertion hash: 원천 사건 identity 전용 (§5.14 assertionHash).
 * resolutionMode·occurredAt·baseAmount·evidenceRef·reason·requestKey 모두 제외.
 */
export function computeAssertionHash(fields: Record<string, unknown>, version: string = 'v1'): string {
  return computePayloadHash(fields, version);
}

/**
 * 증적 정규화 hash.
 */
export function computeEvidenceHash(evidenceRef: string): string {
  const trimmed = evidenceRef.trim();
  return createHash('sha256').update(trimmed, 'utf8').digest('hex');
}

/**
 * 간이 JCS: 키를 유니코드 코드포인트 순으로 정렬해 직렬화.
 */
function canonicalizeJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalizeJson).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonicalizeJson((value as Record<string, unknown>)[k]));
    return '{' + entries.join(',') + '}';
  }
  return String(value);
}
