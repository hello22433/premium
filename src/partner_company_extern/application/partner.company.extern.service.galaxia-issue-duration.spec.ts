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
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { SsgInsertStateService } from '../../delivery/application/ssg-insert-state.service';
import { GalaxiaBarcodeLogEntity } from '../../entity/galaxia.barcode.log.entity';
import { GiftielExchangeHistoryEntity } from '../../entity/giftiel.exchange.history.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { PinIssueDedupEntity } from '../../entity/pin.issue.dedup.entity';
import { SsgIssueLogEntity } from '../../entity/ssg.issue.log.entity';
import { PartnerCompanyExternService } from './partner.company.extern.service';

/**
 * Galaxia issue() duration(유효일수) 선택 로직 검증.
 *
 * Galaxia는 raw 유효일수를 받아 자체적으로 만료일을 산출한다(validityStartsNextDay 보정은
 * ePOPKON 내부 expireAt 계산 전용이라 여기엔 적용하지 않음).
 * cpn 폴백 우선순위: OPM galaxiaDuration ?? Product galaxiaDuration ?? Product expireDay ?? 0.
 * dept(백화점)는 duration을 전달하지 않는다(undefined).
 */
describe('PartnerCompanyExternService - Galaxia issue duration 선택', () => {
  let sut: PartnerCompanyExternService;
  let galaxia: { issue: jest.Mock };

  const makeRepoMock = () => ({
    create: jest.fn(),
    save: jest.fn(),
    insert: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    softDelete: jest.fn(),
    count: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    existsBy: jest.fn(),
    query: jest.fn(),
  });

  /**
   * GALAXIA cpn 주문 빌더.
   * - barCode=null: 이미 발급된 쿠폰 skip 분기를 타지 않게 함
   * - product.type='COUPON': SELF(자체 바코드 생성) 분기 제외
   * - 상품명에 '(백화점)' 미포함: giftKind='cpn'
   */
  const buildOrderDelivery = (overrides: {
    opmGalaxiaDuration?: number | null;
    productGalaxiaDuration?: number | null;
    expireDay?: number;
    productName?: string;
  } = {}): OrderDeliveryEntity =>
    ({
      id: 7001,
      transactionId: 'ENM-GLX-7001',
      deliveryTarget: 'encrypted-target',
      barCode: null,
      couponNum: null,
      orderProductMapping: {
        galaxiaDuration: overrides.opmGalaxiaDuration ?? null,
        product: {
          type: 'COUPON',
          name: overrides.productName ?? '갤럭시아 모바일쿠폰',
          price: 10000,
          expireDay: overrides.expireDay ?? 30,
          galaxiaDuration: overrides.productGalaxiaDuration ?? null,
          partnerCompanyCode: 'GLX-001',
          partnerCompany: { type: 'GALAXIA' },
        },
      },
    }) as unknown as OrderDeliveryEntity;

  beforeEach(async () => {
    jest.clearAllMocks();
    galaxia = {
      issue: jest.fn().mockResolvedValue({
        transactionId: 'GLX-TR-1',
        giftCertificate: { barcode: 'BC-GLX-1' },
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnerCompanyExternService,
        { provide: 'IGalaxia', useValue: galaxia },
        { provide: 'IGsmbiz', useValue: mock<any>() },
        { provide: 'IGiftiel', useValue: mock<any>() },
        { provide: 'IGiftiShow', useValue: mock<any>() },
        { provide: 'ICulture', useValue: mock<any>() },
        { provide: 'ISsgIssue', useValue: mock<any>() },
        { provide: 'IDaou', useValue: mock<any>() },
        { provide: getRepositoryToken(OrderDeliveryEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(PartnerCompanyExternHistoryEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(PartnerCompanyEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(PinIssueDedupEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(SsgIssueLogEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(GiftielExchangeHistoryEntity), useValue: makeRepoMock() },
        { provide: getRepositoryToken(GalaxiaBarcodeLogEntity), useValue: makeRepoMock() },
        { provide: CryptoCipher, useValue: { safeDecryptDeliveryTarget: jest.fn().mockReturnValue('01099998888') } },
        { provide: SsgInsertStateService, useValue: mock<any>() },
      ],
    }).compile();

    sut = module.get(PartnerCompanyExternService);
  });

  const issuedDuration = () => galaxia.issue.mock.calls[0][0].duration;

  it('OPM galaxiaDuration 최우선 (OPM=10, product=20, expireDay=30 → 10)', async () => {
    await sut.issue(
      buildOrderDelivery({ opmGalaxiaDuration: 10, productGalaxiaDuration: 20, expireDay: 30 }),
      null,
    );
    expect(galaxia.issue).toHaveBeenCalledTimes(1);
    expect(galaxia.issue.mock.calls[0][0]).toEqual(expect.objectContaining({ giftKind: 'cpn' }));
    expect(issuedDuration()).toBe(10);
  });

  it('OPM 없으면 product.galaxiaDuration (OPM=null, product=20, expireDay=30 → 20)', async () => {
    await sut.issue(
      buildOrderDelivery({ opmGalaxiaDuration: null, productGalaxiaDuration: 20, expireDay: 30 }),
      null,
    );
    expect(issuedDuration()).toBe(20);
  });

  it('둘 다 없으면 product.expireDay 폴백 (OPM=null, product=null, expireDay=30 → 30)', async () => {
    await sut.issue(
      buildOrderDelivery({ opmGalaxiaDuration: null, productGalaxiaDuration: null, expireDay: 30 }),
      null,
    );
    expect(issuedDuration()).toBe(30);
  });

  it('galaxiaDuration이 명시적 0이면 0 전달 (nullish 아님 → 폴백 안 함, Galaxia 최대값)', async () => {
    await sut.issue(
      buildOrderDelivery({ opmGalaxiaDuration: 0, productGalaxiaDuration: 20, expireDay: 30 }),
      null,
    );
    expect(issuedDuration()).toBe(0);
  });

  it('dept(백화점) 상품은 duration 미전달(undefined), faceValue 전달', async () => {
    await sut.issue(
      buildOrderDelivery({ productName: '신세계상품권(백화점)', expireDay: 30 }),
      null,
    );
    expect(galaxia.issue).toHaveBeenCalledTimes(1);
    const payload = galaxia.issue.mock.calls[0][0];
    expect(payload).toEqual(expect.objectContaining({ giftKind: 'dept', faceValue: '10000' }));
    expect(payload.duration).toBeUndefined();
  });
});
