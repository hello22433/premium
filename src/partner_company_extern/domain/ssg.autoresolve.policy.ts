import { SsgPinResolution } from '../interface/ssg.issue';

/**
 * EP-P30 §9-3 롤아웃 모드. `SSG_PIN_AUTORESOLVE_MODE` 로 주입한다.
 *
 * 기본값·미설정·오타는 전부 `off` 로 해석한다(fail-closed). `off` 는 "코드 경로 전체 차단"이
 * 아니라 **신규 유입 차단 + 신규 PIN 생성 차단**이다(§9-3 drain 규칙).
 */
export enum SsgAutoResolveMode {
  OFF = 'off',
  OBSERVE = 'observe',
  ON = 'on',
}

export function parseSsgAutoResolveMode(raw: string | null | undefined): SsgAutoResolveMode {
  const value = raw?.trim().toLowerCase();
  if (value === SsgAutoResolveMode.OBSERVE) return SsgAutoResolveMode.OBSERVE;
  if (value === SsgAutoResolveMode.ON) return SsgAutoResolveMode.ON;
  return SsgAutoResolveMode.OFF;
}

/**
 * 배포된 단계에서 실제로 열려 있는 자동 발급 능력 (§9 단계표).
 *
 * `on` 을 켜도 이 상수가 false 면 해당 차수 INSERT 는 열리지 않는다. 모드 스위치는 단계 능력을
 * 앞당기는 수단이 아니다.
 *
 * ⚠️ **이 상수는 배포 스위치일 뿐, 실행 근거가 아니다.** 단계 전환을 "상수만 뒤집기"로
 * 끝내면 issue() 1b 가 첫 번째 `tryYn='N'` 하나로 즉시 재발급한다 — §5-4 가 요구하는 경과시간·
 * 연속 N ·해당 ordinal 로그 부재·live claim 증거는 여기 어디에도 없다. 그 증거는
 * `evaluateOrdinal2Execution` 이 별도로 검사하며, 게이트는 **둘 다** 통과해야 열린다.
 *
 * - P0: 판정 레이어와 관측만 배포.
 * - P1(현재): `ORDINAL_1_INITIAL_ISSUE` → true **+** 최초발급 증거(claim 재획득) 구현
 * - P3: `ORDINAL_2_REISSUE` → true **+** `SsgOrdinal2Evidence` 수집경로 구현
 */
export const SSG_AUTORESOLVE_PHASE = {
  ORDINAL_1_INITIAL_ISSUE: true,
  ORDINAL_2_REISSUE: false,
  /**
   * `tryYn='N'` 만으로 orphan resolver 가 state 를 FAILED 로 내려 SSG 행사 잔액 복구(환불)를
   * 집행해도 되는가. §4-2 — `8021`·`0103` 공식 코드 계약과 잔액 차감 여부가 미확정이므로 닫혀 있다.
   * 열기 전까지 orphan resolver 는 판정만 반환하고 ATTEMPTED 를 유지한다.
   */
  REFUND_ON_NOT_ISSUED: false,
} as const;

/** 자동 발급 차수. 1=최초(NOT_ATTEMPTED), 2=재발급(NOT_ISSUED). */
export type SsgIssueOrdinal = 1 | 2;

/**
 * 새 resolver 가 이미 손대본 command 인가 (§9-3).
 *
 * `workflow_version` 은 delivery workflow 의 가변 fencing 카운터라 이 판정에 쓸 수 없다.
 * 전용 durable marker `autoresolve_version` 만 본다. `observe` 는 이 값을 세팅하지 않으므로
 * 관측만으로는 drain 대상이 되지 않는다.
 */
export function isDrainableCommand(command: { autoresolveVersion?: number | null } | null | undefined): boolean {
  return command?.autoresolveVersion === 1;
}

/** 모드 × drain 문맥이 부여하는 실제 권한 (§9-3 capability 매트릭스). */
export interface SsgAutoResolveCapability {
  /** 관측 테이블 기록 */
  recordObservation: boolean;
  /** command/claim durable 전이 */
  commandTransition: boolean;
  /** 이미 등록된 CONFIRMED PIN 을 claim 재획득 후 발송 */
  sendConfirmedPin: boolean;
  /** ordinal=1 신규 INSERT (NOT_ATTEMPTED) */
  insertOrdinal1: boolean;
  /** ordinal=2 신규 INSERT (NOT_ISSUED) */
  insertOrdinal2: boolean;
}

export function resolveSsgAutoResolveCapability(
  mode: SsgAutoResolveMode,
  drainable: boolean,
): SsgAutoResolveCapability {
  if (mode === SsgAutoResolveMode.ON) {
    return {
      recordObservation: true,
      commandTransition: true,
      sendConfirmedPin: true,
      insertOrdinal1: SSG_AUTORESOLVE_PHASE.ORDINAL_1_INITIAL_ISSUE,
      insertOrdinal2: SSG_AUTORESOLVE_PHASE.ORDINAL_2_REISSUE,
    };
  }
  if (mode === SsgAutoResolveMode.OBSERVE) {
    // 순수 관측 — durable state 를 전혀 바꾸지 않는다(§10 불변식 8).
    return {
      recordObservation: true,
      commandTransition: false,
      sendConfirmedPin: false,
      insertOrdinal1: false,
      insertOrdinal2: false,
    };
  }
  // off — drain 중인 command 만 종결까지 마무리한다. 신규 PIN 생성은 어느 경우에도 금지.
  return {
    recordObservation: drainable,
    commandTransition: drainable,
    sendConfirmedPin: drainable,
    insertOrdinal1: false,
    insertOrdinal2: false,
  };
}

/**
 * 차수별 신규 INSERT 게이트 (§6-B-3).
 *
 * 판정값만으로 진행하는 분기는 존재하지 않는다. `NOT_ISSUED`/`NOT_ATTEMPTED` 는 게이트를 통과할
 * 때만 신규 INSERT 로 이어지고, 미통과는 **정상 반환이 아니라 중단**이다(§6-B-3-1).
 */
export function canInsertOrdinal(capability: SsgAutoResolveCapability, ordinal: SsgIssueOrdinal): boolean {
  return ordinal === 1 ? capability.insertOrdinal1 : capability.insertOrdinal2;
}

/**
 * 재발급(ordinal=2) 실행 증거 (§5-4). capability 와 **별개**다.
 *
 * capability 는 "이 단계에서 재발급이라는 행위가 배포됐는가"이고, 이 구조체는 "지금 이 건이
 * 재발급해도 안전한가"다. 둘을 같은 boolean 으로 다루면 배포 스위치 하나가 증거 검사를 생략해
 * 버린다. 모든 필드는 "증명된 경우에만 true" 이며, 수집되지 않은 증거는 undefined 로 두어
 * fail-closed 로 떨어진다.
 */
export interface SsgOrdinal2Evidence {
  /** 직전 INSERT 시도로부터 경과 시간(ms). SSG 등록 지연 창을 넘겨야 미등록이 확정적이다. */
  candidateAgeMs?: number;
  /** 연속된 `tryYn='N'` 관측 횟수(서로 다른 버킷). */
  notIssuedStreak?: number;
  /** 해당 차수(ordinal=2)의 ssg_issue_log 가 아직 없는가 — 중복 재발급 방지. */
  ordinalLogAbsent?: boolean;
  /** 지금 이 순간 delivery mutation claim 을 보유하고 있는가 (fencing). */
  holdsLiveClaim?: boolean;
}

/** 재발급 실행 증거 기준 (§5-4). */
export const SSG_ORDINAL2_EVIDENCE_RULE = {
  /** SSG 등록 반영 지연을 넘기는 최소 경과시간. */
  MIN_CANDIDATE_AGE_MS: 60_000,
  /** 서로 다른 버킷의 연속 미등록 관측 횟수. */
  MIN_NOT_ISSUED_STREAK: 3,
} as const;

/**
 * 재발급 실행 가능 여부. **증거가 하나라도 없으면 false** 다(fail-closed).
 *
 * P0·P1 은 이 증거를 수집하지 않으므로 항상 false 다. 즉 `ORDINAL_2_REISSUE` 상수를 실수로
 * 뒤집어도 재발급은 열리지 않는다 — 증거 수집 경로를 구현해야 비로소 열린다.
 */
export function evaluateOrdinal2Execution(evidence: SsgOrdinal2Evidence | undefined): {
  allowed: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (!evidence) return { allowed: false, missing: ['evidence'] };

  if ((evidence.candidateAgeMs ?? -1) < SSG_ORDINAL2_EVIDENCE_RULE.MIN_CANDIDATE_AGE_MS) missing.push('candidateAge');
  if ((evidence.notIssuedStreak ?? 0) < SSG_ORDINAL2_EVIDENCE_RULE.MIN_NOT_ISSUED_STREAK)
    missing.push('notIssuedStreak');
  if (evidence.ordinalLogAbsent !== true) missing.push('ordinalLogAbsent');
  if (evidence.holdsLiveClaim !== true) missing.push('liveClaim');

  return { allowed: missing.length === 0, missing };
}

/**
 * 차수 INSERT 최종 권한 = 배포 capability **AND** 실행 증거.
 *
 * ordinal=1(최초발급)은 외부 미시도가 전제라 재발급과 같은 증거가 필요 없다(증거는 claim 재획득이며
 * 그건 호출자 계층의 책임이다). ordinal=2 는 반드시 `evaluateOrdinal2Execution` 을 통과해야 한다.
 */
export function canExecuteOrdinal(
  capability: SsgAutoResolveCapability,
  ordinal: SsgIssueOrdinal,
  evidence?: SsgOrdinal2Evidence,
): { allowed: boolean; missing: string[] } {
  if (!canInsertOrdinal(capability, ordinal)) return { allowed: false, missing: ['capability'] };
  if (ordinal === 1) return { allowed: true, missing: [] };
  return evaluateOrdinal2Execution(evidence);
}

/**
 * 후보별 판정을 발송건 단위 판정으로 접는다 (§5-3 우선순위).
 *
 * fallthrough 없이 모든 경우가 여기서 결정된다. `REGISTERED_UNSENDABLE` 는 집계에서도 보존해
 * 전용 경보·관측이 가능하도록 한다(더 일반적인 계약 이상인 `UNKNOWN` 이 우선).
 */
export function aggregateSsgPinResolutions<T>(results: ReadonlyArray<{ candidate: T; resolution: SsgPinResolution }>): {
  resolution: SsgPinResolution;
  confirmedCandidate?: T;
} {
  const confirmed = results.filter((r) => r.resolution === SsgPinResolution.CONFIRMED);
  const has = (resolution: SsgPinResolution) => results.some((r) => r.resolution === resolution);

  if (confirmed.length >= 2) return { resolution: SsgPinResolution.MULTIPLE_CONFIRMED };
  if (has(SsgPinResolution.UNKNOWN)) return { resolution: SsgPinResolution.UNKNOWN };
  if (has(SsgPinResolution.REGISTERED_UNSENDABLE)) return { resolution: SsgPinResolution.REGISTERED_UNSENDABLE };
  if (confirmed.length === 1) {
    if (has(SsgPinResolution.LOOKUP_FAILED) || has(SsgPinResolution.PROCESSING)) {
      return { resolution: SsgPinResolution.LOOKUP_FAILED };
    }
    return { resolution: SsgPinResolution.CONFIRMED, confirmedCandidate: confirmed[0].candidate };
  }
  if (has(SsgPinResolution.LOOKUP_FAILED) || has(SsgPinResolution.PROCESSING)) {
    return { resolution: SsgPinResolution.LOOKUP_FAILED };
  }
  // 후보가 있는데 전부 dead(tryYn='N') → 미등록 확정. 후보 0행은 호출부가 NOT_ATTEMPTED 로 먼저 처리한다.
  return {
    resolution: results.length > 0 ? SsgPinResolution.NOT_ISSUED : SsgPinResolution.NOT_ATTEMPTED,
  };
}

/** 관측 버킷 — 다중 인스턴스 중복 관측을 UNIQUE 로 막기 위한 5분 내림 정렬 시각 (§9-3). */
export const SSG_OBSERVATION_BUCKET_MS = 5 * 60_000;

export function ssgObservationBucketAt(now: Date): Date {
  return new Date(Math.floor(now.getTime() / SSG_OBSERVATION_BUCKET_MS) * SSG_OBSERVATION_BUCKET_MS);
}
