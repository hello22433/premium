jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_t: unknown, _k: unknown, descriptor: unknown) => descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { PartnerDiscountReservationService } from './partner.discount.reservation.service';
import { IPartnerDiscountChangeType } from '../interface/partner.discount.change.type';
import { IPartnerDiscountReservationStatus } from '../interface/partner.discount.reservation.status';
import { IUserDiscountCategory } from '../../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../../user_discount/interface/user.discount.method';
import { ICompareCondition } from '../../user_discount/interface/compare.condition';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { computePayloadHash } from '../domain/proposal.hash';

const DB_NOW = new Date('2026-08-07T05:00:00.000Z');

/** update()/insert() 체이닝을 흉내내는 최소 query builder. */
function queryBuilderStub(overrides: Record<string, unknown> = {}) {
  const qb: any = {
    where: () => qb,
    andWhere: () => qb,
    orderBy: () => qb,
    addOrderBy: () => qb,
    take: () => qb,
    skip: () => qb,
    setLock: () => qb,
    update: () => qb,
    set: () => qb,
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
    getOne: jest.fn().mockResolvedValue(null),
    getMany: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
  return qb;
}

const FIXTURE_SCOPE_KEY = 'sk1|7|PRODUCT_GROUP|-|BULK|-|모바일쿠폰|-|ALL';
const FIXTURE_PAYLOAD_HASH = computePayloadHash(
  {
    scopeKey: FIXTURE_SCOPE_KEY,
    pricePercent: 12,
    priceAdjustment: IPriceAdjustment.DISCOUNT,
    effectiveAt: new Date('2026-08-07T06:00:00.000Z').toISOString(),
  },
  'v1',
);

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    partnerCompanyId: 7,
    category: IUserDiscountCategory.PRODUCT_GROUP,
    classificationId: null,
    method: IUserDiscountMethod.BULK,
    primaryCategory: null,
    group: '모바일쿠폰',
    range: null,
    compareCondition: ICompareCondition.ALL,
    scopeKey: FIXTURE_SCOPE_KEY,
    pricePercent: 12,
    priceAdjustment: IPriceAdjustment.DISCOUNT,
    effectiveAt: new Date('2026-08-07T04:00:00.000Z'),
    status: IPartnerDiscountReservationStatus.PENDING,
    registeredBy: 9,
    resultHistoryId: null,
    requestKey: 'req-1',
    payloadHash: FIXTURE_PAYLOAD_HASH,
    payloadHashVersion: 'v1',
    isRetroactive: false,
    lastFailureCode: null,
    lastFailureAt: null,
    ...overrides,
  } as any;
}

describe('PartnerDiscountReservationService', () => {
  let reservationRepository: any;
  let historyRepository: any;
  let userDiscountRepository: any;
  let historyService: any;
  let featureFlag: any;
  let service: PartnerDiscountReservationService;
  let repriceService: any;
  let updates: any[];
  let calls: string[];
  let insertedRow: any;

  beforeEach(() => {
    updates = [];
    insertedRow = reservation();

    reservationRepository = {
      // 생성 경로는 requestKey 로 기존 예약을 먼저 찾고(기본 없음), INSERT 뒤 id 로 생성 row 를 다시 읽는다.
      // 두 조회를 구분하지 않고 항상 null 을 주면 생성이 InternalServerError 로 떨어진다.
      findOne: jest.fn(async (options: any) => (options?.where?.id !== undefined ? insertedRow : null)),
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 1 }] }),
      query: jest.fn().mockResolvedValue([{ now6: DB_NOW.toISOString() }]),
      createQueryBuilder: jest.fn(() =>
        queryBuilderStub({
          set: (values: any) => {
            updates.push(values);
            return reservationRepository.createQueryBuilder.mock.results.at(-1)?.value;
          },
        }),
      ),
    };
    // set() 이 체이닝을 유지하도록 직접 조립한다.
    reservationRepository.createQueryBuilder = jest.fn(() => {
      const qb: any = queryBuilderStub();
      qb.set = (values: any) => {
        updates.push(values);
        return qb;
      };
      return qb;
    });

    calls = [];
    historyRepository = {
      insert: jest.fn(async () => {
        calls.push('insert');
        return { identifiers: [{ id: 100 }] };
      }),
      update: jest.fn(async (_criteria: any, values: any) => {
        calls.push(values?.validTo !== undefined ? 'close' : 'supersede');
        return { affected: 1 };
      }),
      softDelete: jest.fn(async () => {
        calls.push('retire');
        return { affected: 1 };
      }),
      createQueryBuilder: jest.fn(() => queryBuilderStub()),
    };

    userDiscountRepository = { createQueryBuilder: jest.fn(() => queryBuilderStub()) };

    historyService = {
      lockPolicy: jest.fn().mockResolvedValue(undefined),
      bumpEpoch: jest.fn().mockResolvedValue(undefined),
    };

    featureFlag = { isDiscountReservationCronEnabled: true, isDiscountRetroactiveEnabled: true };

    repriceService = { repriceForReservation: jest.fn().mockResolvedValue({ directCount: 0, proposalCount: 0 }) };

    service = new PartnerDiscountReservationService(
      reservationRepository,
      historyRepository,
      userDiscountRepository,
      historyService,
      repriceService,
      featureFlag,
    );
  });

  describe('createReservation', () => {
    const dto = {
      partnerCompanyId: 7,
      category: IUserDiscountCategory.PRODUCT_GROUP,
      method: IUserDiscountMethod.BULK,
      group: '모바일쿠폰',
      compareCondition: ICompareCondition.ALL,
      pricePercent: 12,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      effectiveAt: '2026-08-07T06:00:00.000Z',
      requestKey: 'req-1',
    } as any;

    it('같은 requestKey·같은 payload 는 기존 예약을 그대로 돌려준다', async () => {
      const created = await service.createReservation(dto, 9);
      reservationRepository.findOne.mockResolvedValue(created);

      const again = await service.createReservation(dto, 9);

      expect(again).toBe(created);
      expect(reservationRepository.insert).toHaveBeenCalledTimes(1);
    });

    it('같은 requestKey·다른 payload 는 409', async () => {
      reservationRepository.findOne.mockResolvedValue(reservation({ payloadHash: 'v1:other' }));

      await expect(service.createReservation(dto, 9)).rejects.toBeInstanceOf(ConflictException);
      expect(reservationRepository.insert).not.toHaveBeenCalled();
    });

    it('소급 예약은 flag off 면 400 — 생성 단계에서 막는다', async () => {
      featureFlag.isDiscountRetroactiveEnabled = false;

      await expect(
        service.createReservation({ ...dto, effectiveAt: '2026-08-01T00:00:00.000Z' }, 9),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('소급 여부는 생성 시점 DB 시각으로 박제한다', async () => {
      await service.createReservation({ ...dto, effectiveAt: '2026-08-01T00:00:00.000Z' }, 9);

      expect(reservationRepository.insert).toHaveBeenCalledWith(expect.objectContaining({ isRetroactive: true }));
    });

    it('미래 예약은 isRetroactive=false', async () => {
      await service.createReservation(dto, 9);

      expect(reservationRepository.insert).toHaveBeenCalledWith(expect.objectContaining({ isRetroactive: false }));
    });

    it('예약 등록만으로는 epoch 를 올리지 않는다 — 원장 계산 근거가 바뀌지 않기 때문', async () => {
      await service.createReservation(dto, 9);

      expect(historyService.lockPolicy).toHaveBeenCalled();
      expect(historyService.bumpEpoch).not.toHaveBeenCalled();
    });

    it('active unique 위반은 409 로 번역한다', async () => {
      reservationRepository.insert.mockRejectedValue(
        new Error("Duplicate entry for key 'uk_partner_discount_reservation_active'"),
      );

      await expect(service.createReservation(dto, 9)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('cancelReservation', () => {
    it('BLOCKED 도 취소 대상이다 — 해제 경로가 이것뿐이다', async () => {
      reservationRepository.findOne.mockResolvedValue(
        reservation({ status: IPartnerDiscountReservationStatus.CANCELED }),
      );

      const canceled = await service.cancelReservation(1);

      expect(canceled.status).toBe(IPartnerDiscountReservationStatus.CANCELED);
      expect(updates.at(-1)).toMatchObject({ status: IPartnerDiscountReservationStatus.CANCELED });
    });

    it('이미 CANCELED 면 200 멱등', async () => {
      reservationRepository.createQueryBuilder = jest.fn(() => {
        const qb: any = queryBuilderStub({ execute: jest.fn().mockResolvedValue({ affected: 0 }) });
        qb.set = () => qb;
        return qb;
      });
      reservationRepository.findOne.mockResolvedValue(
        reservation({ status: IPartnerDiscountReservationStatus.CANCELED }),
      );

      await expect(service.cancelReservation(1)).resolves.toMatchObject({
        status: IPartnerDiscountReservationStatus.CANCELED,
      });
    });

    it('APPLIED 는 409', async () => {
      reservationRepository.createQueryBuilder = jest.fn(() => {
        const qb: any = queryBuilderStub({ execute: jest.fn().mockResolvedValue({ affected: 0 }) });
        qb.set = () => qb;
        return qb;
      });
      reservationRepository.findOne.mockResolvedValue(
        reservation({ status: IPartnerDiscountReservationStatus.APPLIED, resultHistoryId: 100 }),
      );

      await expect(service.cancelReservation(1)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('applyDueReservations', () => {
    it('cron flag off 면 조회조차 하지 않는다', async () => {
      featureFlag.isDiscountReservationCronEnabled = false;

      await expect(service.applyDueReservations()).resolves.toEqual([]);
      expect(reservationRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('applyReservation', () => {
    function stubApply(row: any, intervals: any[] = []) {
      reservationRepository.findOne.mockResolvedValue(row);
      reservationRepository.createQueryBuilder = jest.fn(() => {
        const qb: any = queryBuilderStub({ getOne: jest.fn().mockResolvedValue(row) });
        qb.set = (values: any) => {
          updates.push(values);
          return qb;
        };
        return qb;
      });
      historyRepository.createQueryBuilder = jest.fn(() =>
        queryBuilderStub({ getMany: jest.fn().mockResolvedValue(intervals) }),
      );
    }

    it('발효는 새 값 구간 id 를 resultHistoryId 로 저장하고 epoch 를 올린다', async () => {
      stubApply(reservation());

      const outcome = await service.applyReservation(1);

      expect(outcome).toMatchObject({
        status: IPartnerDiscountReservationStatus.APPLIED,
        resultHistoryId: 100,
      });
      expect(historyService.bumpEpoch).toHaveBeenCalledWith(7);
      expect(updates.at(-1)).toMatchObject({ resultHistoryId: 100 });
    });

    it('history 구간은 cron 실행 시각이 아니라 effectiveAt 으로 연다', async () => {
      const row = reservation();
      stubApply(row);

      await service.applyReservation(1);

      expect(historyRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ validFrom: row.effectiveAt }),
      );
    });

    // UNIQUE(open_key) 는 scope 당 열린 구간 1개만 허용한다. 마감보다 INSERT 가 먼저 나가면
    // 열린 구간이 있는 정상 경로가 duplicate key 로 롤백된다.
    it('기존 열린 구간은 새 구간 INSERT 보다 먼저 마감한다', async () => {
      const row = reservation();
      stubApply(row, [
        {
          id: 5,
          scopeKey: row.scopeKey,
          changeType: IPartnerDiscountChangeType.CREATE,
          pricePercent: 10,
          priceAdjustment: IPriceAdjustment.DISCOUNT,
          validFrom: new Date('2026-07-01T00:00:00.000Z'),
          validTo: null,
        },
      ]);

      await service.applyReservation(1);

      expect(calls).toEqual(['close', 'insert']);
      expect(historyRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 5 }),
        expect.objectContaining({ validTo: row.effectiveAt }),
      );
      // 마감된 row 는 앞부분을 계속 표현한다 — supersede 링크를 걸면 그 구간이 사라진다.
      expect(calls).not.toContain('supersede');
    });

    it('경계 일치 열린 구간은 퇴역 후 INSERT 하고 대체 링크를 건다', async () => {
      const row = reservation();
      stubApply(row, [
        {
          id: 5,
          scopeKey: row.scopeKey,
          changeType: IPartnerDiscountChangeType.CREATE,
          pricePercent: 10,
          priceAdjustment: IPriceAdjustment.DISCOUNT,
          validFrom: row.effectiveAt,
          validTo: null,
        },
      ]);

      await service.applyReservation(1);

      expect(calls).toEqual(['retire', 'insert', 'supersede']);
    });

    it('PENDING 이 아니면 아무 것도 하지 않는다 — 동시 cron 중 승자는 하나다', async () => {
      stubApply(reservation({ status: IPartnerDiscountReservationStatus.CANCELED }));

      const outcome = await service.applyReservation(1);

      expect(outcome.status).toBe(IPartnerDiscountReservationStatus.CANCELED);
      expect(historyRepository.insert).not.toHaveBeenCalled();
    });

    it('소급 예약은 flag off 면 PENDING 유지 — 발효 단계에서도 막는다', async () => {
      featureFlag.isDiscountRetroactiveEnabled = false;
      stubApply(reservation({ isRetroactive: true }));

      const outcome = await service.applyReservation(1);

      expect(outcome).toMatchObject({
        status: IPartnerDiscountReservationStatus.PENDING,
        failureCode: 'RETROACTIVE_DISABLED',
      });
      expect(historyRepository.insert).not.toHaveBeenCalled();
    });

    it('지연된 미래 예약도 발효 시 재가격한다', async () => {
      featureFlag.isDiscountRetroactiveEnabled = false;
      const row = reservation({ isRetroactive: false });
      stubApply(row);

      const outcome = await service.applyReservation(1);

      expect(outcome.status).toBe(IPartnerDiscountReservationStatus.APPLIED);
      expect(repriceService.repriceForReservation).toHaveBeenCalledWith(
        { partnerCompanyId: row.partnerCompanyId, effectiveAt: row.effectiveAt },
        100,
        reservationRepository.manager,
      );
    });

    it('같은 대상에 반대 방향 조건이 활성이면 BLOCKED — 재시도 없이 종결한다', async () => {
      const row = reservation();
      stubApply(row, [
        {
          id: 55,
          partnerCompanyId: 7,
          category: IUserDiscountCategory.PRODUCT_GROUP,
          classificationId: null,
          method: IUserDiscountMethod.SECTION,
          primaryCategory: null,
          group: '모바일쿠폰',
          range: '10000',
          compareCondition: ICompareCondition.ALL,
          scopeKey: 'sk1|7|PRODUCT_GROUP|-|SECTION|-|모바일쿠폰|10000|ALL',
          changeType: IPartnerDiscountChangeType.CREATE,
          pricePercent: 5,
          priceAdjustment: IPriceAdjustment.ADDITIONAL,
          validFrom: new Date('2026-07-01T00:00:00.000Z'),
          validTo: null,
        },
      ]);

      const outcome = await service.applyReservation(1);

      expect(outcome).toMatchObject({
        status: IPartnerDiscountReservationStatus.BLOCKED,
        failureCode: 'POLICY_CONFLICT',
      });
      expect(historyRepository.insert).not.toHaveBeenCalled();
    });
  });
});
