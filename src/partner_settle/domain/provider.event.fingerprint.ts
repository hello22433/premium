import { createHash } from 'crypto';

/**
 * provider 원천 관측 fingerprint (정본 §5.12).
 *
 * 두 용도가 있고 **의미가 다르다**.
 * - `payloadFingerprint` — 관측 lane 의 append/dedup 판정용. 시각을 포함한 관측 payload 전체.
 * - `ingressFingerprint` — orphan lane 의 ingress 수렴용. **시각을 제외한** 비시각 필드만.
 *   시각이 빠져야 같은 malformed event 재수신이 1 row 로 수렴한다.
 *
 * 어느 쪽도 `unresolvedEvidenceKey` 가 아니다(48차-B1) — 같은 날 사용→취소→재사용에서 fingerprint 는
 * 충돌하므로 evidence 는 inbox row id(`INBOX:{id}`)를 쓴다.
 *
 * 값은 `v1:{sha256}` 이다. version prefix 가 없으면 정규화 규칙을 바꾼 순간 과거 row 와 구별할 수 없다.
 */

export const FINGERPRINT_VERSION = 'v1';

/** NULL·undefined·빈 문자열은 전부 같은 sentinel 로 접는다. 안 접으면 같은 사건이 두 hash 로 갈린다. */
const NULL_SENTINEL = '-';

export type FingerprintPart = string | number | null | undefined;

export function normalizeFingerprintParts(parts: FingerprintPart[]): string {
  return parts
    .map((part) => {
      if (part === null || part === undefined) return NULL_SENTINEL;
      const normalized = String(part).trim();
      if (normalized.length === 0) return NULL_SENTINEL;
      // 구분자를 escape 하지 않으면 ['A|B','C'] 와 ['A','B|C'] 가 같은 값이 되어 서로 다른 사건이 병합된다.
      return normalized.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    })
    .join('|');
}

export function buildFingerprint(parts: FingerprintPart[]): string {
  const normalized = normalizeFingerprintParts(parts);
  return `${FINGERPRINT_VERSION}:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}
