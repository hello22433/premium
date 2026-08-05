/**
 * 여신 설정 PUT 의 생성/갱신/충돌 판정 (정본 §5.3 3차 M3 · 21차 M1 · 33차-H6).
 *
 * optimistic lock 규칙을 순수 함수로 고정한다:
 * - row 없음 + `expectedVersion=null`  → CREATE(version 0)
 * - row 없음 + `expectedVersion` 있음  → 충돌(갱신 기대인데 대상 없음)
 * - row 있음 + `expectedVersion=null`  → 충돌(최초 생성 기대인데 이미 존재)
 * - row 있음 + version 불일치           → 충돌(lost update 차단)
 * - row 있음 + version 일치             → UPDATE(version +1)
 */

export type ConfigMutation = { kind: 'CREATE' } | { kind: 'UPDATE'; nextVersion: number };

export class ConfigVersionConflictError extends Error {}

export function decideConfigMutation(
  existingVersion: number | null,
  expectedVersion: number | null,
): ConfigMutation {
  if (existingVersion === null) {
    if (expectedVersion === null) return { kind: 'CREATE' };
    throw new ConfigVersionConflictError(
      `여신 설정 최초 생성은 expectedVersion=null 이어야 합니다 (기대=${expectedVersion})`,
    );
  }
  if (expectedVersion === null || existingVersion !== expectedVersion) {
    throw new ConfigVersionConflictError(
      `여신 설정 version 불일치 (현재=${existingVersion}, 기대=${expectedVersion})`,
    );
  }
  return { kind: 'UPDATE', nextVersion: existingVersion + 1 };
}
