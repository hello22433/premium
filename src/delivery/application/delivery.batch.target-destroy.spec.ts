// typeorm-transactional 데코레이터를 no-op 으로 mock (실제 DB 트랜잭션 없음)
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { DeliveryBatchService } from './delivery.batch.service';

/**
 * 정기 개인정보파기 배치(deliveryDeliveryTargetDestroy) 회귀 테스트.
 *
 * - H-1: order_delivery PII 를 조기파기(executeRequest)와 동일 5종으로 통일 + 환불 진행중 제외.
 * - 리뷰(이기성): order_history 의 PII(수신정보 변경요청/폐기 후 신규 발송 이력의 before/afterChange)도
 *   같이 마스킹해야 함(미파기 시 CS 이력 API 로 평문 수신처 노출). 단 상태 감사 이력은 보존.
 * - 유효기간 가드: 유효기간이 파기예정일보다 뒤인 상품(예: 유효기간 5년 / 파기 180일)에서
 *   수신처가 만료 전에 지워져 재발송·만료안내·CS 대응이 불가능해지던 문제. 유효기간이 남은 건은
 *   만료 다음 날까지 파기를 보류한다. 판정 기준은 유효기간 하나이며 쿠폰 상태는 보지 않는다 —
 *   사용 완료(USED) 건도 유효기간 동안은 보류한다(운영 결정).
 *   비적용 2종(유효기간 없음 / soft-delete 된 tip)은 종전대로 즉시 파기.
 *
 * 생성자 의존성이 많아 Object.create 로 우회 후 필요한 repository 만 mock 주입.
 *
 * ⚠ 이 spec 의 검증 한계 — 반드시 알고 읽어야 한다.
 *   makeSelectQb 의 getMany 는 mockResolvedValue 로 SQL 과 무관하게 고정 배열을 반환한다.
 *   즉 여기서 확인하는 것은 "어떤 SQL 문자열을 QueryBuilder 에 넘겼는가"뿐이고,
 *   "그 SQL 이 실제로 그 행을 걸러내는가"는 원리적으로 검증하지 못한다.
 *   특히 아래 두 가지는 이 방식으로 절대 잡히지 않으므로 DB 통합 테스트가 필요하다:
 *     · NULL 3값 논리 (expireAt NULL 이 `< DATE(:now)` 에서 UNKNOWN 이 되어 행이 통째로 탈락하는 것)
 *     · DATE() 절삭의 자정 경계 동작 (커넥션 TZ 가 KST 라는 전제에 의존)
 *   그 두 축은 delivery.batch.target-destroy-expiry-guard.db-integration-test.ts 가 실DB 로 덮는다.
 *   실행: $env:DATABASE_DATABASE='epopkon_test'; npm run test:db
 *   (전용 test DB 강제 — dropSchema 로 스키마를 밀기 때문. CI 자동 실행 없음 → 수동 확인 필요)
 */
describe('DeliveryBatchService.deliveryDeliveryTargetDestroy', () => {
  // SELECT 용 QueryBuilder mock (where/andWhere 인자 기록)
  const makeSelectQb = (rows: any[]) => {
    const qb: any = { calls: { where: [] as any[], andWhere: [] as any[] } };
    for (const m of ['withDeleted', 'innerJoinAndSelect']) qb[m] = jest.fn(() => qb);
    qb.where = jest.fn((sql: any, params: any) => {
      qb.calls.where.push([sql, params]);
      return qb;
    });
    qb.andWhere = jest.fn((sql: any, params: any) => {
      qb.calls.andWhere.push([sql, params]);
      return qb;
    });
    qb.getMany = jest.fn().mockResolvedValue(rows);
    return qb;
  };

  // order_history UPDATE 용 QueryBuilder mock (set/where/andWhere 인자 기록)
  const makeHistoryQb = () => {
    const qb: any = { calls: { set: [] as any[], where: [] as any[], andWhere: [] as any[] } };
    qb.update = jest.fn(() => qb);
    qb.set = jest.fn((v: any) => {
      qb.calls.set.push(v);
      return qb;
    });
    qb.where = jest.fn((sql: any, p: any) => {
      qb.calls.where.push([sql, p]);
      return qb;
    });
    qb.andWhere = jest.fn((sql: any, p: any) => {
      qb.calls.andWhere.push([sql, p]);
      return qb;
    });
    qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
    return qb;
  };

  const makeSut = (selectQb: any) => {
    const sut: any = Object.create(DeliveryBatchService.prototype);
    // Object.create 로 생성자를 우회하므로 필드 초기화자(logger)가 실행되지 않는다.
    // 배치가 처리 건수를 로그로 남기게 되면서 필요해졌다.
    sut.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
    (sut as any).cutoverGuard = {
      assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
      assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
      isCutover: jest.fn().mockResolvedValue(false),
      splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
    };
    const historyQb = makeHistoryQb();
    // order_delivery 의 createQueryBuilder 는 두 번 쓰인다 —
    //  1회차: 파기 대상 SELECT, 2회차: destroyedAt 각인 UPDATE.
    // 호출 순서로 구분해 돌려준다(같은 mock 을 주면 UPDATE 체인이 SELECT mock 에 걸려 터진다).
    const stampQb = makeHistoryQb(); // update/set/where/andWhere/execute 형태가 동일해 재사용
    let deliveryQbCall = 0;
    sut.orderDeliveryRepository = {
      createQueryBuilder: jest.fn(() => (deliveryQbCall++ === 0 ? selectQb : stampQb)),
      update: jest.fn().mockResolvedValue(undefined),
    };
    sut.orderHistoryRepository = { createQueryBuilder: jest.fn(() => historyQb) };
    sut.__historyQb = historyQb; // 테스트 검사용
    sut.__stampQb = stampQb; // 테스트 검사용
    return sut;
  };

  it('order_delivery 마스킹 대상(SET)이 조기파기와 동일 5종이다', async () => {
    const sut = makeSut(makeSelectQb([{ id: 1 }, { id: 2 }]));

    await sut.deliveryDeliveryTargetDestroy();

    expect(sut.orderDeliveryRepository.update).toHaveBeenCalledTimes(1);
    const [, payload] = sut.orderDeliveryRepository.update.mock.calls[0];
    expect(payload).toEqual({
      deliveryTarget: '-',
      originalDeliveryTarget: '-',
      emailReceiverPhone: '-',
      bankAccount: '-',
      bankAccountOwner: '-',
    });
  });

  it('재수집 조건(WHERE)에 5종 미파기 절이 포함된다(backfill)', async () => {
    const selectQb = makeSelectQb([{ id: 1 }]);
    const sut = makeSut(selectQb);

    await sut.deliveryDeliveryTargetDestroy();

    const piiIdempotency = selectQb.calls.andWhere.find(([sql]: [string]) => sql.includes('emailReceiverPhone'));
    expect(piiIdempotency).toBeDefined();
    for (const col of [
      'deliveryTarget',
      'originalDeliveryTarget',
      'emailReceiverPhone',
      'bankAccount',
      'bankAccountOwner',
    ]) {
      expect(piiIdempotency[0]).toContain(col);
    }
  });

  it('soft-delete 된 행도 파기 대상에 포함한다 (폐기후재발행 롤백, 조기파기와 동일 집합)', async () => {
    const selectQb = makeSelectQb([{ id: 1 }]);
    const sut = makeSut(selectQb);

    await sut.deliveryDeliveryTargetDestroy();

    // withDeleted() 없으면 TypeORM 이 deletedAt IS NULL 을 자동 부착해 롤백 soft-delete 행이 영구 미파기.
    expect(selectQb.withDeleted).toHaveBeenCalled();
  });

  it('파기 기준시각 비교는 날짜(DATE) 단위 절삭이다 — 파기예정일 당일 자정 크론에서 파기', async () => {
    const selectQb = makeSelectQb([{ id: 1 }]);
    const sut = makeSut(selectQb);

    await sut.deliveryDeliveryTargetDestroy();

    const [sql] = selectQb.calls.where[0];
    expect(sql).toContain('DATE_ADD(DATE(orderProductMapping.sendRequestAt)');
    expect(sql).toContain('<= DATE(:now)');
  });

  it('환불 진행중(PROGRESS/APPROVE) 제외 조건이 WHERE 에 포함된다 (조기파기 환불 가드 미러링)', async () => {
    const selectQb = makeSelectQb([{ id: 1 }]);
    const sut = makeSut(selectQb);

    await sut.deliveryDeliveryTargetDestroy();

    const refundGuard = selectQb.calls.andWhere.find(([sql]: [string]) => sql.includes('refundStatus'));
    expect(refundGuard).toBeDefined();
    expect(refundGuard[0]).toContain('IS NULL'); // 환불 없는(NULL) 건은 정상 포함
    expect(refundGuard[1].activeRefundStatuses).toEqual(expect.arrayContaining(['PROGRESS', 'APPROVE']));
  });

  describe('유효기간 가드 — 파기예정일이 유효기간보다 이르면 만료까지 파기 보류', () => {
    // WHERE 절에서 expireAt 가드 절만 뽑아온다.
    const findExpireGuard = (selectQb: any) =>
      selectQb.calls.andWhere.find(([sql]: [string]) => sql.includes('orderDelivery.expireAt'));

    it('만료일 다음 날부터 파기되도록 DATE 절삭 비교한다 (미만료 건은 대상에서 제외)', async () => {
      const selectQb = makeSelectQb([{ id: 1 }]);
      const sut = makeSut(selectQb);

      await sut.deliveryDeliveryTargetDestroy();

      const guard = findExpireGuard(selectQb);
      expect(guard).toBeDefined();
      // `< DATE(:now)` — 만료 당일은 아직 유효하므로 파기하지 않고, 다음 날 자정 회차에서 파기.
      // (cf. 쿠폰 이미지 정리 cleanupExpiredCouponImages 는 `expireAt < now-24h` 인스턴트 비교에
      //  03시 크론이라 방향만 같고 최대 하루 어긋난다 — PII 파기가 먼저, 이미지 삭제가 나중.
      //  이미지에는 수신처가 아니라 PIN 만 들어가므로 무해하나 '정합'은 아니다.)
      expect(guard[0]).toContain('DATE(orderDelivery.expireAt) < DATE(:now)');
    });

    it('유효기간이 없는 건(expireAt IS NULL)은 가드 면제 — 원래 일정대로 파기', async () => {
      const selectQb = makeSelectQb([{ id: 1 }]);
      const sut = makeSut(selectQb);

      await sut.deliveryDeliveryTargetDestroy();

      expect(findExpireGuard(selectQb)[0]).toContain('orderDelivery.expireAt IS NULL');
    });

    it('soft-delete 된 tip(재발행 롤백으로 되감긴 신행)은 가드 비적용 — 유효기간이 남아도 파기', async () => {
      const selectQb = makeSelectQb([{ id: 1 }]);
      const sut = makeSut(selectQb);

      await sut.deliveryDeliveryTargetDestroy();

      // 지워지는 쪽은 구행이 아니라 신행(tip)이다 — customer.service.service.ts:2204.
      // 되감긴 tip 은 고객이 볼 쿠폰이 아니라 붙잡을 이유가 없다.
      // 이 절이 잡는 행은 모두 couponStatus=CANCEL 이기도 하므로(softDelete 가 CANCEL 플립
      // 성공 뒤에만 실행됨), 가드에 couponStatus 절을 추가하면 이 절이 no-op 이 된다.
      expect(findExpireGuard(selectQb)[0]).toContain('orderDelivery.deletedAt IS NOT NULL');
    });

    it('쿠폰 상태로는 좁히지 않는다 — 유효기간이 남으면 사용 완료 건도 보류한다(운영 결정)', async () => {
      const selectQb = makeSelectQb([{ id: 1 }]);
      const sut = makeSut(selectQb);

      await sut.deliveryDeliveryTargetDestroy();

      const guard = findExpireGuard(selectQb);
      // 판정 기준은 유효기간 하나다. couponStatus 절이 다시 들어오면 USED 건이 만료 전에
      // 파기되어 "유효기간 안에는 조회·CS 대응이 가능해야 한다"는 요구가 깨진다.
      expect(guard[0]).not.toContain('couponStatus');
      expect(guard[1]).not.toHaveProperty('liveCouponStatus');
    });

    it('가드 3절의 최상위 결합자는 OR 다 — AND 로 뒤집히면 대량 미파기가 된다', async () => {
      const selectQb = makeSelectQb([{ id: 1 }]);
      const sut = makeSut(selectQb);

      await sut.deliveryDeliveryTargetDestroy();

      const [sql] = findExpireGuard(selectQb);

      // 이 테스트가 지키는 회귀는 딱 하나 — "최상위 결합자가 OR 에서 AND 로 바뀌는 것"이다.
      // AND 가 되면 '유효기간 없음 AND 만료됨 AND 삭제됨'을 모두 만족해야만 파기라,
      // 사실상 아무것도 파기되지 않는다(PII 영구 잔존).
      //
      // 검사 방식: 최상위 OR 로 쪼갠 뒤 3개 항이 서로 다른 조각에 하나씩 들어 있는지 본다.
      // 단순히 `not.toMatch(/\bAND\b/)` 로 AND 를 금지하지 않는 이유 — 항 '내부'의 AND 는
      // 오히려 정당한 개선일 수 있어(예: 특정 항의 NULL 모호성을 명시적으로 좁히는 경우),
      // AND 를 통째로 금지하면 그 수정이 이 테스트에 막힌다.
      // 조각 개수만 고정하고 내부 구조는 자유롭게 둔다.
      const topLevelClauses = sql.split(/\bOR\b/);
      expect(topLevelClauses).toHaveLength(3);

      // 순서는 강제하지 않는다(재배열은 의미 변화가 아니다). 각 항이 '정확히 한 조각'에만 있으면 된다.
      for (const term of [
        'orderDelivery.expireAt IS NULL',
        'DATE(orderDelivery.expireAt) < DATE(:now)',
        'orderDelivery.deletedAt IS NOT NULL',
      ]) {
        expect(topLevelClauses.filter((c: string) => c.includes(term))).toHaveLength(1);
      }
    });

    it('가드는 파기 기준일 절과 :now 를 공유한다 — 다른 값으로 재바인딩되면 커트오프가 통째로 밀린다', async () => {
      const selectQb = makeSelectQb([{ id: 1 }]);
      const sut = makeSut(selectQb);

      await sut.deliveryDeliveryTargetDestroy();

      // TypeORM 은 where/andWhere 의 파라미터를 하나의 맵으로 병합하고 나중 바인딩이 이긴다.
      // 즉 가드에서 `{ now: 다른값 }` 을 넘기면 파기 기준일 절(DATE_ADD(...) <= DATE(:now))의
      // 기준일까지 조용히 함께 이동해 배치 전체의 커트오프가 어긋난다. SQL 문자열 검사로는
      // 절대 잡히지 않는 결함이라, 두 절이 '동일한 값'을 바인딩하는지 여기서 못 박는다.
      const [, cutoffParams] = selectQb.calls.where[0];
      const [, guardParams] = findExpireGuard(selectQb);
      expect(guardParams.now).toBe(cutoffParams.now);
    });
  });

  it('order_history 는 PII type 만 마스킹하고 상태 감사 이력은 보존한다 (리뷰 반영)', async () => {
    const sut = makeSut(makeSelectQb([{ id: 1 }, { id: 2 }]));

    await sut.deliveryDeliveryTargetDestroy();

    const h = sut.__historyQb;
    // before/afterChange 를 '-' 로
    expect(h.calls.set[0]).toEqual({ beforeChange: '-', afterChange: '-' });
    // 발송건 한정
    expect(h.calls.where[0][0]).toContain('orderDeliveryId');
    // type 필터 = PII type 만 (상태 type 제외)
    const [sql, params] = h.calls.andWhere[0];
    expect(sql).toContain('type');
    expect(params.piiTypes).toEqual(expect.arrayContaining(['수신정보 변경요청', '폐기 후 신규 발송']));
    expect(params.piiTypes).not.toContain('폐기');
    expect(params.piiTypes).not.toContain('환불폐기');
    expect(params.piiTypes).not.toContain('핀상태 변경');
  });

  // 각인 대상 판정은 select 결과(마스킹 이전 스냅샷)로 하므로, 행에 destroyedAt/deliveryTarget 을
  // 실제로 담아야 의미 있는 검증이 된다. id 만 담으면 undefined 비교가 되어 공허 통과한다.
  const aliveRow = (id: number) => ({ id, destroyedAt: null, deliveryTarget: '01011112222' });
  const partiallyDestroyedRow = (id: number, at: Date) => ({ id, destroyedAt: at, deliveryTarget: '-' });
  const revivedRow = (id: number, at: Date) => ({ id, destroyedAt: at, deliveryTarget: '01011112222' });

  it('파기 시각(destroyedAt)을 각인한다 — 파기일을 계산이 아니라 기록으로 답하기 위해', async () => {
    // 이 값이 없으면 화면이 파기일을 `발송요청일 + 파기일수` 로 역산하는데, 파기 규칙이 바뀌면
    // 옛 규칙으로 지운 행에 새 규칙이 소급돼 미래 날짜가 인쇄된다(재리뷰 H-1).
    const selectQb = makeSelectQb([aliveRow(1), aliveRow(2)]);
    const sut = makeSut(selectQb);

    await sut.deliveryDeliveryTargetDestroy();

    const stamp = sut.__stampQb;
    expect(stamp.calls.set).toHaveLength(1);
    expect(stamp.calls.where[0][0]).toContain('id IN');
    expect(stamp.calls.where[0][1].ids).toEqual([1, 2]);
    // ★ 타입만 보면(toBeInstanceOf(Date)) `new Date(0)` 같은 회귀가 통과한다 — 파기확인서에
    //   1970-01-01 이 박제되는 변경이 그린으로 지나간다. 커트오프(:now)와 같은 값이어야 한다.
    const [, cutoffParams] = selectQb.calls.where[0];
    expect(stamp.calls.set[0].destroyedAt).toBe(cutoffParams.now);
  });

  it('부분 파기 재수집 행은 최초 파기일을 유지한다 (각인 대상에서 제외)', async () => {
    // 재수집 조건이 "PII 5종 중 하나라도 미파기"라, 이전 회차에 deliveryTarget 만 '-' 가 된 행은
    // 다음 회차에 다시 집힌다. PII 는 그때 이미 사라졌으므로 최초 파기일이 정답이다.
    const first = new Date('2026-01-31T00:00:00');
    const sut = makeSut(makeSelectQb([aliveRow(1), partiallyDestroyedRow(2, first)]));

    await sut.deliveryDeliveryTargetDestroy();

    expect(sut.__stampQb.calls.where[0][1].ids).toEqual([1]);
  });

  it('파기 후 수신처가 재입력된 행은 새 시각으로 갱신한다 (CS 수신정보 변경 경로)', async () => {
    // destroyedAt 은 있는데 수신처가 살아있는 조합. 이 행의 PII 는 재입력 시점부터 지금까지
    // 실제로 살아 있었으므로, 옛 날짜를 유지하면 그 기간을 숨기는 거짓 증명이 된다.
    const first = new Date('2026-01-31T00:00:00');
    const sut = makeSut(makeSelectQb([revivedRow(3, first)]));

    await sut.deliveryDeliveryTargetDestroy();

    expect(sut.__stampQb.calls.where[0][1].ids).toEqual([3]);
  });

  it('각인할 행이 하나도 없으면 각인 UPDATE 자체를 실행하지 않는다', async () => {
    // 전부 부분 파기 재수집인 회차. 빈 IN 절은 SQL 문법 오류가 된다.
    const first = new Date('2026-01-31T00:00:00');
    const sut = makeSut(makeSelectQb([partiallyDestroyedRow(1, first), partiallyDestroyedRow(2, first)]));

    await sut.deliveryDeliveryTargetDestroy();

    expect(sut.__stampQb.calls.set).toHaveLength(0);
  });

  it('파기 시각 각인은 PII 마스킹과 분리된 UPDATE 다 — 마스킹 payload 에 섞이면 매 회차 덮인다', async () => {
    const sut = makeSut(makeSelectQb([{ id: 1 }]));

    await sut.deliveryDeliveryTargetDestroy();

    const [, payload] = sut.orderDeliveryRepository.update.mock.calls[0];
    expect(payload).not.toHaveProperty('destroyedAt');
  });

  it('대상이 없으면 update/history 를 호출하지 않는다(멱등)', async () => {
    const sut = makeSut(makeSelectQb([]));

    await sut.deliveryDeliveryTargetDestroy();

    expect(sut.orderDeliveryRepository.update).not.toHaveBeenCalled();
    expect(sut.orderHistoryRepository.createQueryBuilder).not.toHaveBeenCalled();
  });
});
