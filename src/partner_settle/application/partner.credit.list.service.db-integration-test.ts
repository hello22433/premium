import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';

import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerCreditConfigEntity } from '../../entity/partner.credit.config.entity';
import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';
import { PartnerProviderEventInboxEntity } from '../../entity/partner.provider.event.inbox.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { PartnerCreditListService } from './partner.credit.list.service';

dotenv.config();
jest.setTimeout(120_000);

const TEST_DB_NAME_PATTERN = /test/i;
const NOW = new Date(2026, 6, 15, 12, 0, 0); // 2026-07-15 KST → 전월 = 2026-06

/**
 * 여신 표 조회의 **SQL 집계**를 실 MySQL 로 검증한다 (정본 §4.2·§4.3·§9).
 *
 * 미정산 필터(settleBatchId NULL·NORMAL/ON_HOLD·ADJUSTMENT 제외)·전월 창(직전 마감 월·양수·확정분 포함)·
 * NEEDS_REVIEW count·orphan count·SSG eventBalance 합계·지급조정 합계는 SQL 조건식이 핵심이라
 * repository mock 으로는 못 잡는다. 표시 조립(fail-closed·숨김)은 `credit.list.assembly.spec.ts` 가 커버한다.
 */
describe('PartnerCreditListService — 여신 표 SQL 집계 DB 통합', () => {
  let dataSource: DataSource;
  let service: PartnerCreditListService;
  let daouId: number;
  let ssgId: number;
  let galaxiaId: number;
  let idemSeq = 0;

  beforeAll(async () => {
    initializeTransactionalContext();
    deleteDataSourceByName('default');

    const database = process.env.DATABASE_DATABASE;
    if (!database || !TEST_DB_NAME_PATTERN.test(database)) {
      throw new Error('DB 통합테스트는 이름에 test가 포함된 DATABASE_DATABASE에서만 실행할 수 있습니다.');
    }

    const connection = await mysql.createConnection({
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      user: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      multipleStatements: false,
    });
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await connection.end();

    dataSource = new DataSource({
      type: 'mysql',
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      username: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      database,
      entities: [path.join(process.cwd(), 'src/**/*.entity.ts')],
      namingStrategy: new SnakeNamingStrategy(),
      timezone: '+09:00',
      synchronize: true,
      dropSchema: true,
      logging: false,
      extra: { connectionLimit: 5 },
    });

    await dataSource.initialize();
    addTransactionalDataSource(dataSource);

    const pcRepo = dataSource.getRepository(PartnerCompanyEntity);
    daouId = (await pcRepo.save(pcRepo.create(partnerFixture('DAOU', IPartnerCompanyType.DAOU)))).id;
    ssgId = (await pcRepo.save(pcRepo.create(partnerFixture('SSG', IPartnerCompanyType.SSG)))).id;
    galaxiaId = (await pcRepo.save(pcRepo.create(partnerFixture('GALAXIA', IPartnerCompanyType.GALAXIA)))).id;

    service = new PartnerCreditListService(
      pcRepo,
      dataSource.getRepository(PartnerCreditConfigEntity),
      dataSource.getRepository(PartnerSettleLedgerEntity),
      dataSource.getRepository(PartnerProviderEventInboxEntity),
      dataSource.getRepository(SsgEventEntity),
      [], // 외부 잔액조회는 DAOU/SSG 경로에서 미사용
    );
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM `partner_settle_ledger`');
    await dataSource.query('DELETE FROM `partner_provider_event_inbox`');
    await dataSource.query('DELETE FROM `partner_credit_config`');
    await dataSource.query('DELETE FROM `ssg_event`');
  });

  afterAll(async () => {
    deleteDataSourceByName('default');
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  function partnerFixture(code: string, type: IPartnerCompanyType) {
    return {
      code: `${code}-${Date.now()}-${Math.random()}`,
      corporateNumber: null,
      businessNumber: '000',
      businessName: code,
      businessAddress: '-',
      businessPhoneNumber: '-',
      personName: '-',
      personPhoneNumber: '-',
      personEmail: '-',
      settleCondition: 'POST_PAYMENT' as any,
      settleDay: 1,
      settleMethod: 'CASH' as any,
      maximumLimit: 0,
      bankName: '-',
      bankNumber: '-',
      status: 'ACTIVE' as any,
      validityStartsNextDay: true,
      type,
    };
  }

  async function seedConfig(partnerCompanyId: number, subItemKey: string, amounts: [string, string, string]) {
    await dataSource.getRepository(PartnerCreditConfigEntity).insert({
      partnerCompanyId,
      subItemKey,
      insuranceAmount: amounts[0],
      prepaidAmount: amounts[1],
      etcAmount: amounts[2],
      version: 0,
    });
  }

  async function seedLedger(over: Partial<PartnerSettleLedgerEntity>): Promise<number> {
    const result = await dataSource.getRepository(PartnerSettleLedgerEntity).insert({
      partnerCompanyId: daouId,
      subItemKey: 'NONE',
      sourceType: 'ISSUANCE',
      orderDeliveryId: 1,
      occurredAt: new Date(2026, 6, 10, 0, 0, 0),
      baseAmount: '100',
      settleAmount: '100',
      settleBatchId: null,
      status: 'NORMAL',
      idempotencyKey: `IDEM:${idemSeq++}`,
      ...over,
    });
    return Number(result.identifiers[0].id);
  }

  it('미정산 집계: settleBatchId NULL · NORMAL/ON_HOLD · ADJUSTMENT 제외', async () => {
    await seedConfig(daouId, 'NONE', ['100', '200', '30']); // 월한도 330
    await seedLedger({ baseAmount: '100', status: 'NORMAL', settleBatchId: null });
    await seedLedger({ baseAmount: '50', status: 'ON_HOLD', settleBatchId: null });
    await seedLedger({ baseAmount: '999', sourceType: 'ADJUSTMENT', settleBatchId: null }); // 제외
    await seedLedger({ baseAmount: '70', status: 'NORMAL', settleBatchId: 1 }); // 확정분 → 제외

    const daou = await getRow('DAOU', 'NONE');
    expect(daou.unsettledBaseAmount).toBe('150');
    expect(daou.monthlyLimit).toBe('330');
    expect(daou.availableBalance).toBe('180'); // 330 - 150
    expect(daou.balanceSourceStatus).toBe('AVAILABLE');
    expect(daou.creditDataStatus).toBe('OK');
  });

  it('갤럭시아 백화점 선충전: 브랜드별 settleAmount 전체 배치 합산·역분개 상쇄·ADJUSTMENT 제외', async () => {
    await seedConfig(galaxiaId, 'GALAXIA_LOTTE', ['0', '1000', '0']);
    await seedConfig(galaxiaId, 'GALAXIA_HYUNDAI', ['0', '1000', '0']);
    await seedConfig(galaxiaId, 'GALAXIA_GALLERIA', ['0', '1000', '0']);

    // baseAmount(정가)가 아니라 settleAmount(수수료 차감 후 정산액)를 소진액으로 사용한다.
    const lotteOriginalId = await seedLedger({
      partnerCompanyId: galaxiaId,
      subItemKey: 'GALAXIA_LOTTE',
      baseAmount: '150',
      settleAmount: '100',
      settleBatchId: null,
    });
    // 이미 정산확정된 배치도 선충전 소진액에서는 영구 차감한다.
    await seedLedger({
      partnerCompanyId: galaxiaId,
      subItemKey: 'GALAXIA_LOTTE',
      baseAmount: '60',
      settleAmount: '40',
      settleBatchId: 11,
    });
    // 취소 역분개(음수)는 같은 브랜드 소진액을 상쇄한다.
    await seedLedger({
      partnerCompanyId: galaxiaId,
      subItemKey: 'GALAXIA_LOTTE',
      baseAmount: '-30',
      settleAmount: '-25',
      settleBatchId: 12,
      reversesLedgerId: lotteOriginalId,
    });
    // 내부 차액조정은 갤럭시아 실제 선충전 차감이 아니므로 제외한다.
    await seedLedger({
      partnerCompanyId: galaxiaId,
      subItemKey: 'GALAXIA_LOTTE',
      sourceType: 'ADJUSTMENT',
      baseAmount: '900',
      settleAmount: '900',
    });
    await seedLedger({
      partnerCompanyId: galaxiaId,
      subItemKey: 'GALAXIA_HYUNDAI',
      baseAmount: '250',
      settleAmount: '200',
      settleBatchId: 21,
    });
    await seedLedger({
      partnerCompanyId: galaxiaId,
      subItemKey: 'GALAXIA_GALLERIA',
      baseAmount: '350',
      settleAmount: '300',
      settleBatchId: null,
    });

    const lotte = await getRow('GALAXIA', 'GALAXIA_LOTTE');
    const hyundai = await getRow('GALAXIA', 'GALAXIA_HYUNDAI');
    const galleria = await getRow('GALAXIA', 'GALAXIA_GALLERIA');

    expect(lotte.availableBalance).toBe('885'); // 1000 - (100 + 40 - 25), ADJUSTMENT 제외
    expect(hyundai.availableBalance).toBe('800'); // 브랜드별 별도 합산
    expect(galleria.availableBalance).toBe('700');
    expect([lotte, hyundai, galleria].map((row) => row.balanceSourceStatus)).toEqual([
      'AVAILABLE',
      'AVAILABLE',
      'AVAILABLE',
    ]);

    const mobile = await getRow('GALAXIA', 'GALAXIA_MOBILE');
    expect(mobile.availableBalance).toBeNull();
    expect(mobile.balanceSourceStatus).toBe('NOT_AVAILABLE'); // 실 config 입력 전 숫자 노출 차단
  });

  it('전월 단순 발송금액: 직전 마감 월·양수 row만·확정분 포함·당월/음수/NEEDS_REVIEW 제외', async () => {
    await seedConfig(daouId, 'NONE', ['0', '0', '0']);
    await seedLedger({ baseAmount: '200', occurredAt: new Date(2026, 5, 10), settleBatchId: 5 }); // 6월·확정분 → 포함
    await seedLedger({ baseAmount: '-30', occurredAt: new Date(2026, 5, 11) }); // 음수 → 제외
    await seedLedger({ baseAmount: '400', occurredAt: new Date(2026, 6, 2) }); // 7월(당월) → 제외
    await seedLedger({
      baseAmount: '77',
      occurredAt: new Date(2026, 5, 12),
      status: 'NEEDS_REVIEW',
      reviewResolution: 'PENDING',
      settleAmount: null,
    }); // 제외

    const daou = await getRow('DAOU', 'NONE');
    expect(daou.previousMonthBaseAmount).toBe('200');
  });

  it('NEEDS_REVIEW 미해소 → fail-closed(reviewCount·availableBalance null), DISCARDED 는 제외', async () => {
    await seedConfig(daouId, 'NONE', ['0', '0', '1000']);
    await seedLedger({ baseAmount: '100', status: 'NORMAL' }); // 미정산 100
    await seedLedger({
      baseAmount: '40',
      status: 'NEEDS_REVIEW',
      reviewResolution: 'PENDING',
      reviewCode: 'PRICE_UNRECOVERABLE',
      settleAmount: null,
    });
    await seedLedger({
      baseAmount: '60',
      status: 'NEEDS_REVIEW',
      reviewResolution: 'DISCARDED',
      reviewCode: 'UNKNOWN_PROVIDER_EVENT',
      settleAmount: null,
    }); // 차단·count 제외

    const daou = await getRow('DAOU', 'NONE');
    expect(daou.creditDataStatus).toBe('NEEDS_REVIEW');
    expect(daou.availableBalance).toBeNull();
    expect(daou.reviewCount).toBe(1);
    expect(daou.reviewBaseAmount).toBe('40');
  });

  it('orphan ORPHAN_PENDING → fail-closed(orphanPendingCount)', async () => {
    await seedConfig(daouId, 'NONE', ['0', '0', '500']);
    await dataSource.getRepository(PartnerProviderEventInboxEntity).insert({
      provider: IPartnerCompanyType.DAOU,
      orderDeliveryId: 9,
      sourceType: 'EXCHANGE',
      origin: 'ORPHAN',
      normalizedPayload: {},
      payloadFingerprint: 'pf-1',
      observedStatus: 'X',
      observedAt: new Date(),
      prevInboxRowId: null,
      manualProposalId: null,
      manualLedgerProposalId: null,
      ingressFingerprint: 'ingress-1',
      observationId: null,
      processedStatus: 'ORPHAN_PENDING',
    });

    const daou = await getRow('DAOU', 'NONE');
    expect(daou.creditDataStatus).toBe('NEEDS_REVIEW');
    expect(daou.availableBalance).toBeNull();
    expect(daou.orphanPendingCount).toBe(1);
  });

  it('SSG: 미정산 정가 합계 null · 발송가능잔액 = 현재 활성 행사 eventBalance 합계', async () => {
    await seedConfig(ssgId, 'NONE', ['0', '0', '0']);
    const ssgRepo = dataSource.getRepository(SsgEventEntity);
    await ssgRepo.insert(ssgEvent(100, new Date(2026, 6, 1), new Date(2026, 6, 31))); // 활성
    await ssgRepo.insert(ssgEvent(50, new Date(2026, 6, 1), new Date(2026, 6, 31))); // 활성
    await ssgRepo.insert(ssgEvent(9999, new Date(2026, 0, 1), new Date(2026, 0, 31))); // 종료 → 제외

    const ssg = await getRow('SSG', 'NONE');
    expect(ssg.unsettledBaseAmount).toBeNull();
    expect(ssg.availableBalance).toBe('150');
    expect(ssg.balanceSourceStatus).toBe('AVAILABLE');
  });

  it('지급조정(PAYMENT_VARIANCE) 행: 별도 행으로만 노출·일반 집계 제외', async () => {
    await seedConfig(daouId, 'NONE', ['0', '0', '1000']);
    await seedLedger({ baseAmount: '100', status: 'NORMAL' }); // 일반 미정산
    await seedLedger({
      subItemKey: 'PAYMENT_VARIANCE',
      sourceType: 'ADJUSTMENT',
      status: 'NORMAL',
      settleBatchId: null,
      baseAmount: '500',
      settleAmount: '500',
    });

    const { rows, paymentVarianceRows } = await service.getList(NOW);
    const daou = rows.find((r) => r.partnerType === 'DAOU' && r.subItemKey === 'NONE')!;
    expect(daou.unsettledBaseAmount).toBe('100'); // PAYMENT_VARIANCE 미포함
    expect(paymentVarianceRows).toEqual([
      {
        partnerCompanyId: daouId,
        partnerType: 'DAOU',
        subItemKey: 'PAYMENT_VARIANCE',
        paymentVarianceAdjustmentAmount: '500',
        monthlyLimit: null,
        availableBalance: null,
      },
    ]);
  });

  it('표시 순서: 존재하는 협력사 행이 정본 §4.1 순서를 따른다', async () => {
    const { rows } = await service.getList(NOW);
    const order = rows.map((r) => `${r.partnerType}:${r.subItemKey}`);
    // DAOU·SSG 만 시드 — SSG 가 DAOU 보다 앞선다(표시 순서 이마트→…→다우기술).
    expect(order.indexOf('SSG:NONE')).toBeLessThan(order.indexOf('DAOU:NONE'));
  });

  async function getRow(partnerType: string, subItemKey: string) {
    const { rows } = await service.getList(NOW);
    const row = rows.find((r) => r.partnerType === partnerType && r.subItemKey === subItemKey);
    if (!row) throw new Error(`행 없음: ${partnerType}/${subItemKey}`);
    return row;
  }

  function ssgEvent(eventBalance: number, startAt: Date, endAt: Date) {
    return {
      code: `E${idemSeq++}`,
      no: `N${idemSeq}`,
      order: 1,
      name: '행사',
      startAt,
      endAt,
      couponExpiration: 30,
      eventPrice: eventBalance,
      eventBalance,
    } as Partial<SsgEventEntity>;
  }
});
