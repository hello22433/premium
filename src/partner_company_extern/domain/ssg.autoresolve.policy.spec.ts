import { SsgPinResolution } from '../interface/ssg.issue';
import {
  SSG_AUTORESOLVE_PHASE,
  SsgAutoResolveMode,
  SSG_ORDINAL2_EVIDENCE_RULE,
  aggregateSsgPinResolutions,
  canExecuteOrdinal,
  canInsertOrdinal,
  evaluateOrdinal2Execution,
  isDrainableCommand,
  parseSsgAutoResolveMode,
  resolveSsgAutoResolveCapability,
  ssgObservationBucketAt,
} from './ssg.autoresolve.policy';

/**
 * EP-P30 §9-3 롤아웃 정책 + §5-3 집계 우선순위.
 *
 * 이 파일이 잠그는 불변식: **모드 문자열 하나가 단계 능력을 앞당길 수 없다.** `on` 이라도
 * 배포되지 않은 차수(SSG_AUTORESOLVE_PHASE)는 열리지 않고, 미설정·오타는 항상 `off` 다.
 */
describe('EP-P30 autoresolve 정책', () => {
  describe('모드 파싱 — fail-closed', () => {
    it.each([undefined, null, '', '  ', 'yes', 'true', 'observe_all', 'on1'])(
      '미설정·오타(%s)는 off 로 해석한다',
      (raw) => {
        expect(parseSsgAutoResolveMode(raw as string | undefined)).toBe(SsgAutoResolveMode.OFF);
      },
    );

    it.each([
      ['off', SsgAutoResolveMode.OFF],
      ['observe', SsgAutoResolveMode.OBSERVE],
      ['OBSERVE', SsgAutoResolveMode.OBSERVE],
      [' on ', SsgAutoResolveMode.ON],
      ['ON ', SsgAutoResolveMode.ON],
    ])('정확한 값 %s 는 그대로 해석한다', (raw, expected) => {
      expect(parseSsgAutoResolveMode(raw)).toBe(expected);
    });
  });

  describe('drain marker', () => {
    it('autoresolve_version=1 인 command 만 drain 대상이다', () => {
      expect(isDrainableCommand({ autoresolveVersion: 1 })).toBe(true);
      expect(isDrainableCommand({ autoresolveVersion: null })).toBe(false);
      expect(isDrainableCommand(null)).toBe(false);
      expect(isDrainableCommand(undefined)).toBe(false);
    });
  });

  describe('capability 매트릭스', () => {
    it('off + 신규 command → 관측·전이·발송·INSERT 전부 금지', () => {
      expect(resolveSsgAutoResolveCapability(SsgAutoResolveMode.OFF, false)).toEqual({
        recordObservation: false,
        commandTransition: false,
        sendConfirmedPin: false,
        insertOrdinal1: false,
        insertOrdinal2: false,
      });
    });

    it('off + drain command → 조회·전이·기존 CONFIRMED 발송은 하되 신규 INSERT 는 금지', () => {
      const capability = resolveSsgAutoResolveCapability(SsgAutoResolveMode.OFF, true);
      expect(capability.commandTransition).toBe(true);
      expect(capability.sendConfirmedPin).toBe(true);
      expect(capability.insertOrdinal1).toBe(false);
      expect(capability.insertOrdinal2).toBe(false);
    });

    it('observe 는 순수 관측 — durable 전이·발송·INSERT 0', () => {
      expect(resolveSsgAutoResolveCapability(SsgAutoResolveMode.OBSERVE, true)).toEqual({
        recordObservation: true,
        commandTransition: false,
        sendConfirmedPin: false,
        insertOrdinal1: false,
        insertOrdinal2: false,
      });
    });

    it('on 이어도 배포되지 않은 차수는 열리지 않는다 (단계 상수가 최종 권위)', () => {
      const capability = resolveSsgAutoResolveCapability(SsgAutoResolveMode.ON, false);
      expect(capability.insertOrdinal1).toBe(SSG_AUTORESOLVE_PHASE.ORDINAL_1_INITIAL_ISSUE);
      expect(capability.insertOrdinal2).toBe(SSG_AUTORESOLVE_PHASE.ORDINAL_2_REISSUE);
      expect(canInsertOrdinal(capability, 1)).toBe(SSG_AUTORESOLVE_PHASE.ORDINAL_1_INITIAL_ISSUE);
      expect(canInsertOrdinal(capability, 2)).toBe(SSG_AUTORESOLVE_PHASE.ORDINAL_2_REISSUE);
    });

    it('P0 배포분에서는 어떤 모드에서도 신규 INSERT 가 열리지 않는다', () => {
      for (const mode of [SsgAutoResolveMode.OFF, SsgAutoResolveMode.OBSERVE, SsgAutoResolveMode.ON]) {
        for (const drainable of [false, true]) {
          const capability = resolveSsgAutoResolveCapability(mode, drainable);
          expect(canInsertOrdinal(capability, 1)).toBe(false);
          expect(canInsertOrdinal(capability, 2)).toBe(false);
        }
      }
    });
  });

  /**
   * 배포 capability 와 실행 권한은 다른 질문이다. 둘을 하나의 boolean 으로 다루면 P3 에서 상수만
   * 뒤집었을 때 issue() 가 첫 번째 `tryYn='N'` 하나로 즉시 재발급해 버린다.
   */
  describe('재발급 실행 증거 (§5-4)', () => {
    const fullEvidence = {
      candidateAgeMs: SSG_ORDINAL2_EVIDENCE_RULE.MIN_CANDIDATE_AGE_MS,
      notIssuedStreak: SSG_ORDINAL2_EVIDENCE_RULE.MIN_NOT_ISSUED_STREAK,
      ordinalLogAbsent: true,
      holdsLiveClaim: true,
    };
    const openOrdinal2 = {
      recordObservation: true,
      commandTransition: true,
      sendConfirmedPin: true,
      insertOrdinal1: true,
      insertOrdinal2: true,
    };

    it('증거 자체가 없으면 false (fail-closed)', () => {
      expect(evaluateOrdinal2Execution(undefined)).toEqual({ allowed: false, missing: ['evidence'] });
    });

    it('증거가 전부 모이면 통과한다', () => {
      expect(evaluateOrdinal2Execution(fullEvidence)).toEqual({ allowed: true, missing: [] });
    });

    it.each([
      ['candidateAge', { candidateAgeMs: SSG_ORDINAL2_EVIDENCE_RULE.MIN_CANDIDATE_AGE_MS - 1 }],
      ['notIssuedStreak', { notIssuedStreak: SSG_ORDINAL2_EVIDENCE_RULE.MIN_NOT_ISSUED_STREAK - 1 }],
      ['ordinalLogAbsent', { ordinalLogAbsent: false }],
      ['liveClaim', { holdsLiveClaim: false }],
    ])('%s 하나만 빠져도 재발급은 열리지 않는다', (missing, override) => {
      const result = evaluateOrdinal2Execution({ ...fullEvidence, ...override });
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain(missing);
    });

    it('capability 가 열려도 증거가 없으면 재발급 실행은 막힌다 (상수만 뒤집는 사고 방지)', () => {
      expect(canExecuteOrdinal(openOrdinal2, 2)).toEqual({ allowed: false, missing: ['evidence'] });
      expect(canExecuteOrdinal(openOrdinal2, 2, fullEvidence).allowed).toBe(true);
    });

    it('최초발급(ordinal=1)은 재발급 증거를 요구하지 않는다', () => {
      expect(canExecuteOrdinal(openOrdinal2, 1)).toEqual({ allowed: true, missing: [] });
    });

    it('capability 가 닫힐 때는 증거와 무관하게 막힌다', () => {
      const closed = { ...openOrdinal2, insertOrdinal1: false, insertOrdinal2: false };
      expect(canExecuteOrdinal(closed, 2, fullEvidence)).toEqual({ allowed: false, missing: ['capability'] });
      expect(canExecuteOrdinal(closed, 1)).toEqual({ allowed: false, missing: ['capability'] });
    });
  });

  describe('집계 우선순위 (§5-3)', () => {
    const verdicts = (...resolutions: SsgPinResolution[]) =>
      resolutions.map((resolution, index) => ({ candidate: index, resolution }));

    it('CONFIRMED 2건 → MULTIPLE_CONFIRMED', () => {
      expect(
        aggregateSsgPinResolutions(verdicts(SsgPinResolution.CONFIRMED, SsgPinResolution.CONFIRMED)).resolution,
      ).toBe(SsgPinResolution.MULTIPLE_CONFIRMED);
    });

    it('UNKNOWN 이 섞이면 CONFIRMED 를 선택하지 않는다', () => {
      expect(
        aggregateSsgPinResolutions(verdicts(SsgPinResolution.CONFIRMED, SsgPinResolution.UNKNOWN)).resolution,
      ).toBe(SsgPinResolution.UNKNOWN);
    });

    it('UNKNOWN 과 REGISTERED_UNSENDABLE 이 혼재하면 더 일반적인 UNKNOWN 이 이긴다', () => {
      expect(
        aggregateSsgPinResolutions(verdicts(SsgPinResolution.REGISTERED_UNSENDABLE, SsgPinResolution.UNKNOWN))
          .resolution,
      ).toBe(SsgPinResolution.UNKNOWN);
    });

    it('단일 REGISTERED_UNSENDABLE 는 UNKNOWN 으로 소실되지 않는다 (전용 경보 가능)', () => {
      expect(aggregateSsgPinResolutions(verdicts(SsgPinResolution.REGISTERED_UNSENDABLE)).resolution).toBe(
        SsgPinResolution.REGISTERED_UNSENDABLE,
      );
    });

    it('CONFIRMED 1건 + 나머지 dead → 그 후보를 재사용한다', () => {
      const result = aggregateSsgPinResolutions(verdicts(SsgPinResolution.CONFIRMED, SsgPinResolution.NOT_ISSUED));
      expect(result.resolution).toBe(SsgPinResolution.CONFIRMED);
      expect(result.confirmedCandidate).toBe(0);
    });

    it('CONFIRMED 1건 + LOOKUP_FAILED 혼재 → LOOKUP_FAILED (재조회 후 확정)', () => {
      const result = aggregateSsgPinResolutions(verdicts(SsgPinResolution.CONFIRMED, SsgPinResolution.LOOKUP_FAILED));
      expect(result.resolution).toBe(SsgPinResolution.LOOKUP_FAILED);
      expect(result.confirmedCandidate).toBeUndefined();
    });

    it('dead 아닌 미확정이 하나라도 있으면 NOT_ISSUED 로 확정하지 않는다', () => {
      expect(
        aggregateSsgPinResolutions(verdicts(SsgPinResolution.NOT_ISSUED, SsgPinResolution.LOOKUP_FAILED)).resolution,
      ).toBe(SsgPinResolution.LOOKUP_FAILED);
    });

    it('전부 dead → NOT_ISSUED', () => {
      expect(
        aggregateSsgPinResolutions(verdicts(SsgPinResolution.NOT_ISSUED, SsgPinResolution.NOT_ISSUED)).resolution,
      ).toBe(SsgPinResolution.NOT_ISSUED);
    });

    it('후보가 없으면 NOT_ATTEMPTED — fallthrough UNKNOWN 이 남지 않는다', () => {
      expect(aggregateSsgPinResolutions([]).resolution).toBe(SsgPinResolution.NOT_ATTEMPTED);
    });
  });

  describe('관측 버킷', () => {
    it('5분 단위로 내림 정렬해 동시 관측이 같은 버킷에 모인다', () => {
      const a = ssgObservationBucketAt(new Date('2026-08-14T10:07:31.500Z'));
      const b = ssgObservationBucketAt(new Date('2026-08-14T10:09:59.999Z'));
      const c = ssgObservationBucketAt(new Date('2026-08-14T10:10:00.000Z'));

      expect(a.toISOString()).toBe('2026-08-14T10:05:00.000Z');
      expect(b.getTime()).toBe(a.getTime());
      expect(c.toISOString()).toBe('2026-08-14T10:10:00.000Z');
    });
  });
});
