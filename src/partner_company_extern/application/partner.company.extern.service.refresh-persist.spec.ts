import { PartnerSettleFeatureFlag } from '../../partner_settle/application/partner.settle.feature.flag';
import { PartnerSettleProducerService } from '../../partner_settle/application/partner.settle.producer.service';
import { SsgAutoResolveConfig } from './ssg.autoresolve.config';
import { SsgPinObservationService } from './ssg.pin.observation.service';
// 실제 DB 연결 없는 단위 테스트이므로 typeorm-transactional 데코레이터를 no-op으로 mock한다.
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, _descriptor: unknown) => _descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { PinIssueDedupEntity } from '../../entity/pin.issue.dedup.entity';
import { SsgIssueLogEntity } from '../../entity/ssg.issue.log.entity';
import { PinIssueCommandEntity } from '../../entity/pin.issue.command.entity';
import { SsgResendDeductPendingEntity } from '../../entity/ssg.resend.deduct.pending.entity';
import { GiftielExchangeHistoryEntity } from '../../entity/giftiel.exchange.history.entity';
import { GalaxiaBarcodeLogEntity } from '../../entity/galaxia.barcode.log.entity';
import { SsgInsertStateService } from '../../delivery/application/ssg-insert-state.service';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { PartnerCompanyExternService } from './partner.company.extern.service';

const makeRepoMock = () => ({
  create: jest.fn(),
  save: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
  softDelete: jest.fn(),
  count: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  existsBy: jest.fn(),
  query: jest.fn(),
  createQueryBuilder: jest.fn(),
});

/**
 * refreshCouponStatus 의 **영속 계약** (D3-55/D3-60, 커밋 d3670fd).
 *
 * 이 메서드는 종전에 `save(orderDelivery)` 로 끝났다. save = merge = **행 전체 쓰기**인데,
 * 이 메서드의 엔티티 스냅샷은 협력사 조회(외부 HTTP, 수 초) **전에** 로드된 것이다. 그 창에서
 * 폐기·재발행이 mutation_claimed_at(변형 lease)을 잡으면, 여기 save 가 스냅샷의 null 로
 * **남의 살아있는 lease 를 지운다** → 진행 중인 재발행의 fenced write 가 affected=0 이 되고
 * (아무도 선점하지 않았는데 운영자에게 409), 폐기×재발행 교차 창이 다시 열린다.
 * 그래서 targeted update 로 바꿨다.
 *
 * ── 이 spec 이 잠그는 계약은 **두 축**이다. 한쪽만 잠그면 지난 라운드의 실패가 반복된다. ──
 *
 * 지난 라운드에 oneSend 의 save 를 지우면서 저자가 "이 메서드가 쓰는 컬럼은 6개가 전부"라고
 * 단언하고 그걸 `expect(Object.keys(set)).toEqual([...6개])` 로 못박았는데, 그 6개에 barCode 가
 * 빠져 있었다 — 테스트가 **누락을 계약으로 굳혀** CRITICAL 자금 결함을 지켰다.
 * 컬럼 화이트리스트 동결(Object.keys equality)은 그래서 여기서 쓰지 않는다. 대신:
 *
 *   ① (clobber 금지) SET 에 **있으면 안 되는** 컬럼: mutationClaimedAt / barCode / deletedAt /
 *      status / claimedAt … — 이 메서드가 소유하지 않는 컬럼을 stale 스냅샷으로 되쓰는 순간
 *      save 시절의 결함이 그대로 돌아온다.
 *
 *   ② (누락 금지) 이 호출이 엔티티에 **실제로 대입한 모든 필드**가 SET 에 있어야 한다.
 *      화이트리스트를 손으로 세지 않고, Proxy 로 대입을 관찰해 자동 대조한다.
 *      → 미래에 누가 협력사 분기에 새 컬럼 대입(예: `orderDelivery.balanceAt = ...`)을 추가하고
 *        update 목록 갱신을 잊으면, 그 분기를 태우는 테스트가 **자동으로** 빨개진다.
 *        barCode 급 사고를 화이트리스트 갱신 규율에 맡기지 않는다.
 *
 * 대입 필드는 협력사 분기마다 다르므로 ②는 분기별로 태워야 의미가 있다 —
 * GALAXIA / GIFTIEL / DAOU / SSG 4개 분기(+ CANCEL·USED 서로 다른 경로)를 커버한다.
 */
describe('PartnerCompanyExternService.refreshCouponStatus — 영속 계약 (targeted update)', () => {
  let sut: PartnerCompanyExternService;
  let galaxia: any;
  let giftiel: any;
  let daou: any;
  let ssgIssue: any;
  let orderDeliveryRepository: ReturnType<typeof makeRepoMock>;
  let galaxiaBarcodeLogRepository: ReturnType<typeof makeRepoMock>;
  let giftielExchangeHistoryRepository: ReturnType<typeof makeRepoMock>;

  /**
   * 이 메서드가 **소유하지 않는** 컬럼들. SET 에 나타나면 stale 스냅샷 clobber 다.
   *  - mutationClaimedAt : 남의 변형 lease 를 지운다 (이 커밋이 막으려던 바로 그 결함)
   *  - barCode/personalCode/couponNum/ssgTransactionId : PIN. NULL 로 되쓰면 협력사 취소가
   *    `if (barCode && ...)` 가드에서 스킵된 채 환불만 나간다 = 자금 손실
   *  - deletedAt : soft-delete 된 재발행 tip 을 되살린다
   *  - status/claimedAt/reportState : 발송 파이프라인 소유 컬럼. 되쓰면 좀비/이중발송
   */
  const FORBIDDEN_COLUMNS = [
    'mutationClaimedAt',
    'barCode',
    'personalCode',
    'couponNum',
    'ssgTransactionId',
    'deletedAt',
    'status',
    'claimedAt',
    'reportState',
    'ssgEventId',
    'expireAt',
  ];

  const buildOrderDelivery = (overrides: Record<string, any> = {}): any => ({
    id: 3001,
    transactionId: 'ENM3D3001',
    couponNum: 'CN-3001',
    barCode: 'BC-3001',
    personalCode: 'PC-3001',
    couponStatus: OrderDeliveryCouponStatus.NOT_USED,
    discardedAt: null,
    tradeAt: null,
    tradePlace: null,
    galaxiaBalance: null,
    // ↓ clobber 되면 안 되는 것들이 스냅샷에 살아 있는 상태를 재현한다
    mutationClaimedAt: null,
    deletedAt: null,
    sendRequestAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  });

  const withPartner = (type: string, productOverrides: Record<string, any> = {}, overrides: Record<string, any> = {}) =>
    buildOrderDelivery({
      orderProductMapping: {
        product: {
          name: '테스트 상품',
          partnerCompanyCode: 'PCC-1',
          expireDay: 90,
          partnerCompany: { type },
          ...productOverrides,
        },
      },
      ...overrides,
    });

  /** 마지막으로 만들어진 UPDATE QueryBuilder (refreshCouponStatus 의 optimistic CAS). */
  let lastQb: any;

  /**
   * 엔티티 대입을 Proxy 로 관찰하며 refreshCouponStatus 를 태운 뒤,
   *  - save() 가 아니라 **QueryBuilder CAS** 로 영속됐는지
   *  - ①clobber 금지 컬럼이 SET 에 없는지
   *  - ②이번 호출이 대입한 모든 필드가 SET 에 있는지
   *  - ③진입 시점 coupon_status 를 대조하는 CAS 술어(`coupon_status <=> :loaded`)가 있는지
   * 를 한 번에 대조한다. set 페이로드를 돌려주므로 분기별 값 검증은 호출자가 이어서 한다.
   *
   * ③이 없으면: 협력사 조회(수 초) 도중 폐기가 coupon_status=CANCEL + 환불을 확정했을 때
   * 이 update 가 stale 한 NOT_USED 로 덮어써 **환불된 쿠폰이 되살아난다**(D3-60 본체).
   */
  const runAndAssertPersistContract = async (od: any) => {
    const loadedCouponStatus = od.couponStatus ?? null;
    const assigned = new Set<string>();
    const tracked = new Proxy(od, {
      set(target, prop, value) {
        assigned.add(String(prop));
        (target as any)[prop] = value;
        return true;
      },
    });

    await sut.refreshCouponStatus(tracked as unknown as OrderDeliveryEntity);

    // save 로 되돌아가면 여기서 죽는다 — 이 커밋의 본체다.
    expect(orderDeliveryRepository.save).not.toHaveBeenCalled();
    expect(lastQb).toBeDefined();
    expect(lastQb.execute).toHaveBeenCalledTimes(1);

    const set = lastQb.set.mock.calls[0][0];
    const idWhere = lastQb.where.mock.calls.find((c: any[]) => /id = :id/.test(String(c[0])));
    expect(idWhere).toBeDefined();
    expect(idWhere[1]).toEqual({ id: od.id });

    // ① clobber 금지
    for (const col of FORBIDDEN_COLUMNS) {
      expect(Object.keys(set)).not.toContain(col);
    }

    // ② 누락 금지 — 대입했는데 SET 에 없는 컬럼이 있으면 그 값은 DB 에 영영 안 남는다
    const missing = [...assigned].filter((k) => !(k in set));
    expect(missing).toEqual([]);

    // ③ optimistic CAS — 진입 시점 값에서 변하지 않았을 때만 쓴다
    const cas = lastQb.andWhere.mock.calls.find((c: any[]) => /coupon_status <=> :loaded/.test(String(c[0])));
    expect(cas).toBeDefined();
    expect(cas[1]).toEqual({ loaded: loadedCouponStatus });

    return set;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    galaxia = { issue: jest.fn(), check: jest.fn(), cancel: jest.fn() };
    giftiel = { issue: jest.fn(), check: jest.fn(), cancel: jest.fn() };
    daou = { issue: jest.fn(), check: jest.fn(), cancel: jest.fn() };
    ssgIssue = { issue: jest.fn(), check: jest.fn(), cancel: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnerCompanyExternService,
        { provide: 'IGalaxia', useValue: galaxia },
        { provide: 'IGsmbiz', useValue: mock<any>() },
        { provide: 'IGiftiel', useValue: giftiel },
        { provide: 'IGiftiShow', useValue: mock<any>() },
        { provide: 'ICulture', useValue: mock<any>() },
        { provide: 'ISsgIssue', useValue: ssgIssue },
        { provide: 'IDaou', useValue: daou },
        {
          provide: getRepositoryToken(OrderDeliveryEntity),
          useValue: { ...mock<Repository<OrderDeliveryEntity>>(), ...makeRepoMock() },
        },
        {
          provide: getRepositoryToken(PartnerCompanyExternHistoryEntity),
          useValue: { ...mock<Repository<PartnerCompanyExternHistoryEntity>>(), ...makeRepoMock() },
        },
        {
          provide: getRepositoryToken(PartnerCompanyEntity),
          useValue: { ...mock<Repository<PartnerCompanyEntity>>(), ...makeRepoMock() },
        },
        {
          provide: getRepositoryToken(PinIssueDedupEntity),
          useValue: { ...mock<Repository<PinIssueDedupEntity>>(), ...makeRepoMock() },
        },
        {
          provide: getRepositoryToken(SsgIssueLogEntity),
          useValue: { ...mock<Repository<SsgIssueLogEntity>>(), ...makeRepoMock() },
        },
        { provide: getRepositoryToken(PinIssueCommandEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(SsgResendDeductPendingEntity), useValue: {} },
        { provide: PartnerSettleFeatureFlag, useValue: { isEnabled: false, isEnabledFor: () => false } },
        { provide: PartnerSettleProducerService, useValue: {} },
        { provide: SsgAutoResolveConfig, useValue: new SsgAutoResolveConfig({ get: () => 'off' } as any) },
        { provide: SsgPinObservationService, useValue: { record: jest.fn() } },
        {
          provide: getRepositoryToken(GiftielExchangeHistoryEntity),
          useValue: { ...mock<Repository<GiftielExchangeHistoryEntity>>(), ...makeRepoMock() },
        },
        {
          provide: getRepositoryToken(GalaxiaBarcodeLogEntity),
          useValue: { ...mock<Repository<GalaxiaBarcodeLogEntity>>(), ...makeRepoMock() },
        },
        { provide: CryptoCipher, useValue: { safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01000000000') } },
        {
          provide: SsgInsertStateService,
          useValue: {
            markAttempted: jest.fn(),
            markConfirmed: jest.fn(),
            markFailed: jest.fn(),
            getState: jest.fn(),
          },
        },
      ],
    }).compile();

    sut = module.get<PartnerCompanyExternService>(PartnerCompanyExternService);
    orderDeliveryRepository = module.get(getRepositoryToken(OrderDeliveryEntity));
    galaxiaBarcodeLogRepository = module.get(getRepositoryToken(GalaxiaBarcodeLogEntity));
    giftielExchangeHistoryRepository = module.get(getRepositoryToken(GiftielExchangeHistoryEntity));

    lastQb = undefined;
    orderDeliveryRepository.createQueryBuilder.mockImplementation(() => {
      const qb: any = {
        update: jest.fn(() => qb),
        set: jest.fn(() => qb),
        where: jest.fn(() => qb),
        andWhere: jest.fn(() => qb),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      lastQb = qb;
      return qb;
    });
    orderDeliveryRepository.update.mockResolvedValue({ affected: 1 });
    orderDeliveryRepository.save.mockImplementation((e: any) => Promise.resolve(e));
    galaxiaBarcodeLogRepository.existsBy.mockResolvedValue(false);
    giftielExchangeHistoryRepository.findOne.mockResolvedValue(null);
  });

  describe('GALAXIA', () => {
    it('사용(USED): couponStatus/tradeAt/galaxiaBalance 를 DB 에 남기고, lease·PIN 컬럼은 건드리지 않는다', async () => {
      const od = withPartner('GALAXIA');
      galaxia.check.mockResolvedValue({
        giftCertificate: {
          couponStatus: 'ACTIVE',
          isUsed: true,
          faceValue: '10000',
          balance: '0',
          usedDate: '20260714120000',
          validTo: '99991231',
        },
      });

      const set = await runAndAssertPersistContract(od);

      expect(set.couponStatus).toBe(OrderDeliveryCouponStatus.USED);
      expect(set.tradeAt).toBeInstanceOf(Date);
      // 잔액형 쿠폰의 잔액 — 정산/CS 조회의 근거값이다. 메모리에만 남으면 아무도 못 본다.
      expect(set.galaxiaBalance).toBe(0);
    });

    it('CANCEL: discardedAt 과 교환정보 비움(null)이 함께 영속된다', async () => {
      const od = withPartner('GALAXIA', {}, { tradeAt: new Date('2026-01-01'), tradePlace: '이전 교환처' });
      galaxia.check.mockResolvedValue({
        giftCertificate: {
          couponStatus: 'CANCEL',
          isUsed: false,
          faceValue: '10000',
          balance: '10000', // 전액 잔존 → 교환정보 제거 대상
          usedDate: null,
          validTo: '99991231',
        },
      });

      const set = await runAndAssertPersistContract(od);

      expect(set.couponStatus).toBe(OrderDeliveryCouponStatus.CANCEL);
      expect(set.discardedAt).toBeInstanceOf(Date);
      // null 로 **덮어써야** 한다. update 목록에서 tradeAt/tradePlace 를 빼면 DB 엔 옛 교환정보가
      // 남아 CS 화면이 "폐기된 쿠폰인데 교환처가 있다" 는 모순을 보여준다.
      expect(set.tradeAt).toBeNull();
      expect(set.tradePlace).toBeNull();
    });
  });

  describe('GIFTIEL', () => {
    it('사용(USED): tradeAt/tradePlace 가 DB 에 남는다', async () => {
      const od = withPartner('GIFTIEL');
      giftiel.check.mockResolvedValue({
        UseYn: 'Y',
        UseDate: '2026-07-14 12:00:00',
        BiName: 'GS25 강남점',
        DayEnd: '2026-12-31',
      });

      const set = await runAndAssertPersistContract(od);

      expect(set.couponStatus).toBe(OrderDeliveryCouponStatus.USED);
      expect(set.tradeAt).toBeInstanceOf(Date);
      expect(set.tradePlace).toBe('GS25 강남점');
    });
  });

  describe('DAOU', () => {
    it('기취소(02): couponStatus=CANCEL + discardedAt 이 DB 에 남는다', async () => {
      const od = withPartner('DAOU');
      daou.check.mockResolvedValue({ resultCode: 'S000001', cpnStatus: '02' });

      const set = await runAndAssertPersistContract(od);

      expect(set.couponStatus).toBe(OrderDeliveryCouponStatus.CANCEL);
      // discardedAt 이 빠지면 폐기 시각이 없는 CANCEL 이 되어 정산·CS 추적이 끊긴다
      expect(set.discardedAt).toBeInstanceOf(Date);
    });
  });

  describe('SSG', () => {
    it('교환완료(0400): tradePlace/tradeAt 이 DB 에 남는다', async () => {
      const od = withPartner('SSG', {}, { ssgEvent: { no: 'EV1', order: 1 } });
      ssgIssue.check.mockResolvedValue({
        response: {
          value: [
            {
              resultCd: ['0400'],
              payaccntNm: ['이마트 성수점'],
              executeDate: ['2026-07-14T09:00:00.000Z'],
            },
          ],
        },
      });

      const set = await runAndAssertPersistContract(od);

      expect(set.couponStatus).toBe(OrderDeliveryCouponStatus.USED);
      expect(set.tradePlace).toBe('이마트 성수점');
      expect(set.tradeAt).toBeInstanceOf(Date);
    });

    /**
     * SSG 는 이미 폐기된 건이면 조기 break 한다 — 그래도 update 는 나간다.
     * 이 경로가 위험한 이유: 조기 break 는 **메모리 스냅샷의 couponStatus 를 그대로 되쓴다.**
     * (아래 "잔여 위험" 참고 — fencing 이 없어 stale CANCEL/REFUND_CANCEL 되쓰기가 가능하다.)
     * 최소한 PIN·lease 컬럼은 절대 SET 에 없어야 한다는 것만은 여기서도 잠근다.
     */
    it('이미 폐기(CANCEL)면 상태를 바꾸지 않고, 협력사 조회도 하지 않는다', async () => {
      const od = withPartner(
        'SSG',
        {},
        { couponStatus: OrderDeliveryCouponStatus.CANCEL, ssgEvent: { no: 'EV1', order: 1 } },
      );

      const set = await runAndAssertPersistContract(od);

      expect(ssgIssue.check).not.toHaveBeenCalled();
      expect(set.couponStatus).toBe(OrderDeliveryCouponStatus.CANCEL);
    });
  });
});
