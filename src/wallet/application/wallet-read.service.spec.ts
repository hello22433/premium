import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { PointGrantEntity } from '../../entity/point.grant.entity';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { UserEntity } from '../../entity/user.entity';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import { WalletReadService } from './wallet-read.service';

/** 체이닝 query builder mock. andWhere 인자를 capture 해 필터 검증. */
function makeQb(raw: any) {
  const calls: { method: string; args: any[] }[] = [];
  const qb: any = {};
  for (const m of ['select', 'addSelect', 'leftJoin', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'limit']) {
    qb[m] = jest.fn((...args: any[]) => {
      calls.push({ method: m, args });
      return qb;
    });
  }
  qb.getRawOne = jest.fn(async () => raw);
  qb.getRawMany = jest.fn(async () => raw);
  qb._calls = calls;
  return qb;
}

describe('WalletReadService', () => {
  let sut: WalletReadService;
  let walletRepo: jest.Mocked<Repository<WalletAccountEntity>>;
  let pointRepo: jest.Mocked<Repository<PointGrantEntity>>;
  let allocRepo: jest.Mocked<Repository<OrderPaymentAllocationEntity>>;
  let userRepo: jest.Mocked<Repository<UserEntity>>;
  let companyRepo: jest.Mocked<Repository<UserCompanyEntity>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletReadService,
        { provide: getRepositoryToken(WalletAccountEntity), useValue: { findOne: jest.fn(), createQueryBuilder: jest.fn() } },
        { provide: getRepositoryToken(PointGrantEntity), useValue: { createQueryBuilder: jest.fn() } },
        { provide: getRepositoryToken(OrderPaymentAllocationEntity), useValue: { createQueryBuilder: jest.fn() } },
        { provide: getRepositoryToken(UserEntity), useValue: { createQueryBuilder: jest.fn(), find: jest.fn() } },
        { provide: getRepositoryToken(UserCompanyEntity), useValue: { findOne: jest.fn() } },
      ],
    }).compile();
    sut = module.get(WalletReadService);
    walletRepo = module.get(getRepositoryToken(WalletAccountEntity));
    pointRepo = module.get(getRepositoryToken(PointGrantEntity));
    allocRepo = module.get(getRepositoryToken(OrderPaymentAllocationEntity));
    userRepo = module.get(getRepositoryToken(UserEntity));
    companyRepo = module.get(getRepositoryToken(UserCompanyEntity));

    companyRepo.findOne.mockResolvedValue({ id: 7, businessName: '테스트상사' } as UserCompanyEntity);
    // 기본: 회사 네이밍 wallet 코드 없음(빈 목록). 필요한 테스트에서만 override.
    walletRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
  });

  describe('getSettlementCodeSnapshot', () => {
    it('다중 settlementCode → 코드별 분리 + 잔액/포인트', async () => {
      userRepo.createQueryBuilder.mockReturnValue(
        makeQb([{ settlementCode: 'company-7' }, { settlementCode: 'company-7-mkt' }]),
      );
      walletRepo.findOne.mockImplementation(
        async ({ where }: any) =>
          (where.ownerId === 'company-7'
            ? {
                id: '11',
                depositBalance: 5000,
                creditLimit: 100000,
                creditUsedAmount: 2000,
                creditExcessAmount: 0,
                cardSurchargeApplied: false,
              }
            : {
                id: '22',
                depositBalance: 0,
                creditLimit: 50000,
                creditUsedAmount: 0,
                creditExcessAmount: 300,
                cardSurchargeApplied: true,
              }) as any,
      );
      pointRepo.createQueryBuilder.mockReturnValueOnce(makeQb({ total: '1500' }) as any);
      pointRepo.createQueryBuilder.mockReturnValueOnce(makeQb({ total: '0' }) as any);
      userRepo.find.mockResolvedValue([{ id: 1, personName: '홍길동' } as UserEntity]);

      const res = await sut.getSettlementCodeSnapshot(7);

      expect(res.companyName).toBe('테스트상사');
      expect(res.settlementCodes).toHaveLength(2);
      expect(res.settlementCodes[0]).toMatchObject({
        settlementCode: 'company-7',
        walletAccountId: '11',
        walletStatus: 'ACTIVE',
        depositBalance: 5000,
        pointTotalRemaining: 1500,
        cardSurchargeApplied: false,
      });
      expect(res.settlementCodes[1].creditExcessAmount).toBe(300);
      expect(res.settlementCodes[1].pointTotalRemaining).toBe(0);
    });

    it('wallet 미존재 → walletStatus MISSING, 금액 0, walletAccountId null', async () => {
      userRepo.createQueryBuilder.mockReturnValue(makeQb([{ settlementCode: 'company-7' }]));
      walletRepo.findOne.mockResolvedValue(null);
      userRepo.find.mockResolvedValue([{ id: 1, personName: '홍길동' } as UserEntity]);

      const res = await sut.getSettlementCodeSnapshot(7);

      expect(res.settlementCodes[0]).toMatchObject({
        walletStatus: 'MISSING',
        walletAccountId: null,
        depositBalance: 0,
        pointTotalRemaining: 0,
        cardSurchargeApplied: true,
      });
      expect(res.settlementCodes[0].assignedUsers).toHaveLength(1);
      expect(pointRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('point SUM 은 만료/비활성/소진 제외 필터 적용', async () => {
      userRepo.createQueryBuilder.mockReturnValue(makeQb([{ settlementCode: 'company-7' }]));
      walletRepo.findOne.mockResolvedValue({
        id: '11',
        depositBalance: 0,
        creditLimit: 0,
        creditUsedAmount: 0,
        creditExcessAmount: 0,
      } as any);
      const pointQb = makeQb({ total: '900' });
      pointRepo.createQueryBuilder.mockReturnValue(pointQb as any);
      userRepo.find.mockResolvedValue([]);

      await sut.getSettlementCodeSnapshot(7);

      const andWheres = pointQb._calls.filter((c: any) => c.method === 'andWhere').map((c: any) => c.args[0]);
      expect(andWheres).toContain('p.active = 1');
      expect(andWheres).toContain('p.remainingAmount > 0');
      expect(andWheres).toContain('(p.expiresAt IS NULL OR p.expiresAt > NOW())');
    });

    it('user 0명 회사 → settlementCodes 빈 배열 + companyName', async () => {
      userRepo.createQueryBuilder.mockReturnValue(makeQb([]));
      const res = await sut.getSettlementCodeSnapshot(7);
      expect(res.companyName).toBe('테스트상사');
      expect(res.settlementCodes).toEqual([]);
    });

    it('company 미존재 → NotFoundException', async () => {
      companyRepo.findOne.mockResolvedValue(null);
      await expect(sut.getSettlementCodeSnapshot(999)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('유저 0명이라도 홈 회사(owner_company_id) 정산코드 wallet(빈 코드)은 스냅샷에 노출 (재배정 대상 후보)', async () => {
      // distinctSettlementCodes: company-7 (유저 있음)만 참조
      userRepo.createQueryBuilder.mockReturnValue(makeQb([{ settlementCode: 'company-7' }]));
      // ownerCompanyWalletCodes(owner_company_id=7): company-7 + company-7-2 (company-7-2 는 유저 0명 빈 코드)
      walletRepo.createQueryBuilder.mockReturnValue(
        makeQb([{ ownerId: 'company-7' }, { ownerId: 'company-7-2' }]) as any,
      );
      walletRepo.findOne.mockImplementation(
        async ({ where }: any) =>
          (({
            'company-7': { id: '11', depositBalance: 5000, creditLimit: 0, creditUsedAmount: 0, creditExcessAmount: 0 },
            'company-7-2': { id: '22', depositBalance: 300, creditLimit: 0, creditUsedAmount: 0, creditExcessAmount: 0 },
          }) as any)[where.ownerId],
      );
      pointRepo.createQueryBuilder.mockReturnValue(makeQb({ total: '0' }) as any);
      userRepo.find.mockImplementation(
        async ({ where }: any) =>
          (where.settlementCode === 'company-7' ? [{ id: 1, personName: '홍길동' }] : []) as any,
      );

      const res = await sut.getSettlementCodeSnapshot(7);

      expect(res.settlementCodes.map((c) => c.settlementCode)).toEqual(['company-7', 'company-7-2']);
      const empty = res.settlementCodes.find((c) => c.settlementCode === 'company-7-2')!;
      expect(empty.assignedUsers).toEqual([]);
      expect(empty.walletStatus).toBe('ACTIVE');
      expect(empty.depositBalance).toBe(300);
    });

    it('ownerCompanyWalletCodes 는 owner_company_id 로 홈 회사 wallet 을 조회 (네이밍 파싱 아님)', async () => {
      userRepo.createQueryBuilder.mockReturnValue(makeQb([]));
      const walletQb = makeQb([]);
      walletRepo.createQueryBuilder.mockReturnValue(walletQb as any);

      await sut.getSettlementCodeSnapshot(7);

      // ownerType=SETTLEMENT_CODE 로 좁힌 뒤 owner_company_id 로 홈 회사 필터 (다른 타입/네이밍 파싱 아님)
      const whereCall = walletQb._calls.find((c: any) => c.method === 'where');
      expect(whereCall.args[0]).toBe('w.ownerType = :t');
      expect(whereCall.args[1]).toMatchObject({ t: 'SETTLEMENT_CODE' });
      const andWhere = walletQb._calls.find((c: any) => c.method === 'andWhere');
      expect(andWhere.args[0]).toBe('w.ownerCompanyId = :companyId');
      expect(andWhere.args[1]).toMatchObject({ companyId: 7 });
    });

    it('교차회사 공유 코드(타 회사 홈)는 이 회사 유저 참조(distinct)로 스냅샷에 노출 — owner_company_id 필터엔 안 걸림', async () => {
      // company-3-2 는 3번 회사 홈(owner_company_id=3) → owner_company_id=7 필터엔 미포함.
      // 그러나 7번 회사 유저가 이 코드를 쓰므로 distinctSettlementCodes(7) 로 잡혀야 한다(합집합).
      userRepo.createQueryBuilder.mockReturnValue(makeQb([{ settlementCode: 'company-3-2' }, { settlementCode: 'company-7' }]));
      // ownerCompanyWalletCodes(7): 7번 홈 코드만 (company-3-2 는 없음)
      walletRepo.createQueryBuilder.mockReturnValue(makeQb([{ ownerId: 'company-7' }]) as any);
      walletRepo.findOne.mockImplementation(
        async ({ where }: any) =>
          (({
            'company-7': { id: '11', depositBalance: 0, creditLimit: 0, creditUsedAmount: 0, creditExcessAmount: 0 },
            'company-3-2': { id: '32', depositBalance: 900, creditLimit: 0, creditUsedAmount: 0, creditExcessAmount: 0 },
          }) as any)[where.ownerId],
      );
      pointRepo.createQueryBuilder.mockReturnValue(makeQb({ total: '0' }) as any);
      userRepo.find.mockImplementation(
        async ({ where }: any) =>
          // companyId 스코프 검증: companyId=7 이 아니면 매칭 안 됨(회귀 시 assignedUsers 빈 배열 → 실패)
          (where.companyId === 7 && where.settlementCode === 'company-3-2' ? [{ id: 9, personName: '교차유저' }] : []) as any,
      );

      const res = await sut.getSettlementCodeSnapshot(7);

      const codes = res.settlementCodes.map((c) => c.settlementCode);
      expect(codes).toContain('company-3-2'); // 타 회사 소유지만 7번 유저 참조로 노출
      expect(codes).toContain('company-7');
      const cross = res.settlementCodes.find((c) => c.settlementCode === 'company-3-2')!;
      expect(cross.assignedUsers).toEqual([{ userId: 9, personName: '교차유저' }]);
      // assignedUsers 는 이 회사(companyId=7) 로 스코프 — 타 회사(3번) 유저는 포함하지 않는다.
      expect(userRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { companyId: 7, settlementCode: 'company-3-2' } }),
      );
    });

    it('커스텀 이름(비-company-* ownerId) 홈 코드도 owner_company_id 로 스냅샷 포함 (네이밍 파싱 아님 — 실데이터 증명)', async () => {
      userRepo.createQueryBuilder.mockReturnValue(makeQb([])); // distinct: 참조 유저 없음
      walletRepo.createQueryBuilder.mockReturnValue(makeQb([{ ownerId: 'vip-main' }]) as any); // owner_company_id=7 홈(비정형 이름)
      walletRepo.findOne.mockResolvedValue({
        id: '77',
        depositBalance: 100,
        creditLimit: 0,
        creditUsedAmount: 0,
        creditExcessAmount: 0,
      } as any);
      pointRepo.createQueryBuilder.mockReturnValue(makeQb({ total: '0' }) as any);
      userRepo.find.mockResolvedValue([]);

      const res = await sut.getSettlementCodeSnapshot(7);

      expect(res.settlementCodes.map((c) => c.settlementCode)).toEqual(['vip-main']);
      expect(res.settlementCodes[0].walletStatus).toBe('ACTIVE');
      expect(res.settlementCodes[0].depositBalance).toBe(100);
    });
  });

  describe('getSettlementCodeDetail', () => {
    it('settlementCode 공백 → BadRequestException (조회 미실행)', async () => {
      await expect(sut.getSettlementCodeDetail('   ', 7)).rejects.toBeInstanceOf(BadRequestException);
      expect(walletRepo.findOne).not.toHaveBeenCalled();
    });

    it('companyId 오류 → BadRequestException', async () => {
      await expect(sut.getSettlementCodeDetail('company-7', 0)).rejects.toBeInstanceOf(BadRequestException);
      expect(walletRepo.findOne).not.toHaveBeenCalled();
    });

    it('wallet 없고 배정 계정 0 → NotFoundException', async () => {
      walletRepo.findOne.mockResolvedValue(null);
      userRepo.createQueryBuilder.mockReturnValue(makeQb([]));
      await expect(sut.getSettlementCodeDetail('company-7', 7)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('wallet 없지만 배정 계정 존재 → walletStatus MISSING + walletAccountId null + 계정 반환 (포인트 미조회)', async () => {
      walletRepo.findOne.mockResolvedValue(null);
      userRepo.createQueryBuilder.mockReturnValue(
        makeQb([{ userId: '1', personName: '홍길동', companyId: '7', companyName: 'A상사' }]),
      );

      const res = await sut.getSettlementCodeDetail('company-7', 7);

      expect(res).toMatchObject({
        settlementCode: 'company-7',
        walletStatus: 'MISSING',
        walletAccountId: null,
        depositBalance: 0,
        pointTotalRemaining: 0,
        ownerCompanyId: null,
        renameAllowed: false,
        renameBlockReason: 'WALLET_MISSING',
      });
      expect(res.assignedAccounts).toEqual([{ userId: 1, personName: '홍길동', companyId: 7, companyName: 'A상사' }]);
      expect(pointRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('wallet 존재 → ACTIVE + 잔액/포인트 + 교차회사 계정(N:M) 전부 반환', async () => {
      walletRepo.findOne.mockResolvedValue({
        id: '11',
        depositBalance: 5000,
        creditLimit: 100000,
        creditUsedAmount: 2000,
        creditExcessAmount: 0,
        settleCondition: 'POST_PAYMENT',
        settleMethod: 'CASH',
        cardSurchargeApplied: false,
        ownerCompanyId: 7,
      } as any);
      // 회사 걸침: 3번·7번 회사 계정이 같은 코드를 공유 (companyId ASC 정렬)
      const detailQb = makeQb([
        { userId: '3', personName: '삼번', companyId: '3', companyName: 'B상사' },
        { userId: '7', personName: '칠번', companyId: '7', companyName: 'A상사' },
      ]);
      userRepo.createQueryBuilder.mockReturnValue(detailQb);
      pointRepo.createQueryBuilder.mockReturnValue(makeQb({ total: '1500' }) as any);

      const res = await sut.getSettlementCodeDetail('company-7', 7);

      expect(res).toMatchObject({
        settlementCode: 'company-7',
        walletAccountId: '11',
        walletStatus: 'ACTIVE',
        depositBalance: 5000,
        pointTotalRemaining: 1500,
        cardSurchargeApplied: false,
        ownerCompanyId: 7,
        renameAllowed: false,
        renameBlockReason: 'CROSS_COMPANY_REFERENCE',
      });
      expect(res.assignedAccounts).toEqual([
        { userId: 3, personName: '삼번', companyId: 3, companyName: 'B상사' },
        { userId: 7, personName: '칠번', companyId: 7, companyName: 'A상사' },
      ]);
      // 정렬 계약(회사 ASC → 계정 id ASC)을 실제 호출로 검증 — mock 행 순서 의존이 아니라 orderBy 자체를 고정.
      const orderBy = detailQb._calls.find((c: any) => c.method === 'orderBy');
      expect(orderBy.args).toEqual(['u.companyId', 'ASC']);
      const addOrderBy = detailQb._calls.find((c: any) => c.method === 'addOrderBy');
      expect(addOrderBy.args).toEqual(['u.id', 'ASC']);
    });

    it('배정 계정 0명인 홈 회사 코드 → rename 허용', async () => {
      walletRepo.findOne.mockResolvedValue({
        id: '11',
        ownerCompanyId: 7,
        depositBalance: 0,
        creditLimit: 0,
        creditUsedAmount: 0,
        creditExcessAmount: 0,
        settleCondition: 'POST_PAYMENT',
        settleMethod: 'CASH',
        cardSurchargeApplied: true,
      } as any);
      userRepo.createQueryBuilder.mockReturnValue(makeQb([]));
      pointRepo.createQueryBuilder.mockReturnValue(makeQb({ total: '0' }) as any);

      await expect(sut.getSettlementCodeDetail('nvida', 7)).resolves.toMatchObject({
        ownerCompanyId: 7,
        renameAllowed: true,
        renameBlockReason: null,
        assignedAccounts: [],
      });
    });

    it.each([
      {
        requestCompanyId: 8,
        rows: [],
        reason: 'NOT_OWNER_COMPANY',
      },
      {
        requestCompanyId: 7,
        rows: [{ userId: '1', personName: '미연결', companyId: null, companyName: null }],
        reason: 'COMPANYLESS_REFERENCE',
      },
    ])('$reason → rename 차단 enum 반환', async ({ requestCompanyId, rows, reason }) => {
      walletRepo.findOne.mockResolvedValue({
        id: '11',
        ownerCompanyId: 7,
        depositBalance: 0,
        creditLimit: 0,
        creditUsedAmount: 0,
        creditExcessAmount: 0,
        settleCondition: 'POST_PAYMENT',
        settleMethod: 'CASH',
        cardSurchargeApplied: true,
      } as any);
      userRepo.createQueryBuilder.mockReturnValue(makeQb(rows));
      pointRepo.createQueryBuilder.mockReturnValue(makeQb({ total: '0' }) as any);

      await expect(sut.getSettlementCodeDetail('nvida', requestCompanyId)).resolves.toMatchObject({
        renameAllowed: false,
        renameBlockReason: reason,
      });
    });
  });

  describe('getSettlementCodeUsage', () => {
    it('기간 집계 + includeReleased=false → releasedAt IS NULL 필터', async () => {
      userRepo.createQueryBuilder.mockReturnValue(makeQb([{ settlementCode: 'company-7' }]));
      walletRepo.findOne.mockResolvedValue({ id: '11' } as any);
      const allocQb = makeQb({
        walletPaidAmount: '12000',
        depositUsedAmount: '5000',
        creditUsedAmount: '7000',
        creditExcessAmount: '0',
        pointUsedAmount: '300',
        orderCount: '4',
      });
      allocRepo.createQueryBuilder.mockReturnValue(allocQb as any);

      const res = await sut.getSettlementCodeUsage(7, '2026-06-01', '2026-06-30', false);

      expect(res.periodBasis).toBe('WALLET_DEDUCTED_AT');
      expect(res.settlementCodes[0]).toMatchObject({ walletPaidAmount: 12000, orderCount: 4, creditUsedAmount: 7000 });
      const andWheres = allocQb._calls.filter((c: any) => c.method === 'andWhere').map((c: any) => c.args[0]);
      expect(andWheres).toContain('a.releasedAt IS NULL');
    });

    it('includeReleased=true → releasedAt 필터 미적용', async () => {
      userRepo.createQueryBuilder.mockReturnValue(makeQb([{ settlementCode: 'company-7' }]));
      walletRepo.findOne.mockResolvedValue({ id: '11' } as any);
      const allocQb = makeQb({
        walletPaidAmount: '0',
        depositUsedAmount: '0',
        creditUsedAmount: '0',
        creditExcessAmount: '0',
        pointUsedAmount: '0',
        orderCount: '0',
      });
      allocRepo.createQueryBuilder.mockReturnValue(allocQb as any);

      await sut.getSettlementCodeUsage(7, '2026-06-01', '2026-06-30', true);

      const andWheres = allocQb._calls.filter((c: any) => c.method === 'andWhere').map((c: any) => c.args[0]);
      expect(andWheres).not.toContain('a.releasedAt IS NULL');
    });

    it('wallet 미존재 → MISSING + 0 집계 (allocation 미조회)', async () => {
      userRepo.createQueryBuilder.mockReturnValue(makeQb([{ settlementCode: 'company-7' }]));
      walletRepo.findOne.mockResolvedValue(null);

      const res = await sut.getSettlementCodeUsage(7, '2026-06-01', '2026-06-30', false);

      expect(res.settlementCodes[0]).toMatchObject({ walletStatus: 'MISSING', walletPaidAmount: 0, orderCount: 0 });
      expect(allocRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('유저 0명이라도 홈 회사(owner_company_id) 정산코드는 사용량 목록에도 포함 (§2.3 snapshot·usage 도출 통일)', async () => {
      userRepo.createQueryBuilder.mockReturnValue(makeQb([])); // distinct: 참조 유저 0
      walletRepo.createQueryBuilder.mockReturnValue(makeQb([{ ownerId: 'company-7-empty' }]) as any); // owner_company_id=7 홈
      walletRepo.findOne.mockResolvedValue({ id: '9' } as any);
      allocRepo.createQueryBuilder.mockReturnValue(
        makeQb({
          walletPaidAmount: '0',
          depositUsedAmount: '0',
          creditUsedAmount: '0',
          creditExcessAmount: '0',
          pointUsedAmount: '0',
          orderCount: '0',
        }) as any,
      );

      const res = await sut.getSettlementCodeUsage(7, '2026-06-01', '2026-06-30', false);

      // distinct 단독이면 빈 배열이었을 코드가 owner_company_id 합집합으로 노출됨
      expect(res.settlementCodes.map((c) => c.settlementCode)).toEqual(['company-7-empty']);
    });

    it('from/to 누락 → BadRequestException', async () => {
      await expect(sut.getSettlementCodeUsage(7, '', '2026-06-30', false)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('searchSettlementCodes', () => {
    const makeRow = (over: any = {}) => ({
      walletAccountId: '10',
      settlementCode: 'company-7-2',
      ownerCompanyId: 7,
      ownerCompanyName: '테스트상사',
      settleCondition: 'POST_PAYMENT',
      settleMethod: 'CASH',
      depositBalance: '0',
      creditLimit: '5000000',
      creditUsedAmount: '0',
      creditExcessAmount: '0',
      assignedUserCount: '0',
      ...over,
    });
    const andWheres = (qb: any) => qb._calls.filter((c: any) => c.method === 'andWhere');

    it('배정 계정 0개 코드도 매핑되어 노출(P1), 숫자 변환·nextCursor null', async () => {
      const qb = makeQb([makeRow()]);
      walletRepo.createQueryBuilder.mockReturnValueOnce(qb as any);

      const res = await sut.searchSettlementCodes({ companyId: 7 });

      expect(res.items).toHaveLength(1);
      expect(res.items[0]).toMatchObject({
        settlementCode: 'company-7-2',
        walletAccountId: '10',
        ownerCompanyId: 7,
        ownerCompanyName: '테스트상사',
        walletStatus: 'ACTIVE',
        depositBalance: 0,
        creditLimit: 5000000,
        assignedUserCount: 0,
      });
      expect(res.nextCursor).toBeNull();
    });

    it('필터 전부 → andWhere 절 구성', async () => {
      const qb = makeQb([]);
      walletRepo.createQueryBuilder.mockReturnValueOnce(qb as any);

      await sut.searchSettlementCodes({
        companyId: 7,
        settleCondition: 'PRE_PAYMENT',
        settleMethod: 'CARD',
        depositMin: 0,
        depositMax: 100,
        creditLimitMin: 1000,
        creditLimitMax: 9000,
        codeQuery: 'company-7',
        cursor: '5',
      });

      const clauses = andWheres(qb).map((c: any) => c.args[0]);
      expect(clauses).toEqual(
        expect.arrayContaining([
          'w.ownerCompanyId = :cid',
          'w.settleCondition = :sc',
          'w.settleMethod = :sm',
          'w.depositBalance >= :dmin',
          'w.depositBalance <= :dmax',
          'w.creditLimit >= :lmin',
          'w.creditLimit <= :lmax',
          "w.ownerId LIKE :cq ESCAPE '!'",
          'w.id > :cursor',
        ]),
      );
    });

    it('codeQuery LIKE 와일드카드 이스케이프', async () => {
      const qb = makeQb([]);
      walletRepo.createQueryBuilder.mockReturnValueOnce(qb as any);

      await sut.searchSettlementCodes({ codeQuery: '100%_x' });

      const like = andWheres(qb).find((c: any) => c.args[0] === "w.ownerId LIKE :cq ESCAPE '!'");
      expect(like.args[1].cq).toBe('%100!%!_x%');
    });

    it('limit+1 초과 → 마지막 잘라내고 nextCursor 반환', async () => {
      const qb = makeQb([
        makeRow({ walletAccountId: '10' }),
        makeRow({ walletAccountId: '20' }),
        makeRow({ walletAccountId: '30' }),
      ]);
      walletRepo.createQueryBuilder.mockReturnValueOnce(qb as any);

      const res = await sut.searchSettlementCodes({ limit: 2 });

      expect(res.items.map((i) => i.walletAccountId)).toEqual(['10', '20']);
      expect(res.nextCursor).toBe('20');
    });

    it('잘못된 settleCondition → BadRequest', async () => {
      await expect(sut.searchSettlementCodes({ settleCondition: 'X' as any })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('예치금 min > max → BadRequest', async () => {
      await expect(sut.searchSettlementCodes({ depositMin: 100, depositMax: 10 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('limit 0 → BadRequest', async () => {
      await expect(sut.searchSettlementCodes({ limit: 0 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cursor 비정수 → BadRequest', async () => {
      await expect(sut.searchSettlementCodes({ cursor: 'abc' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('codeQuery 50자 초과 → BadRequest', async () => {
      await expect(sut.searchSettlementCodes({ codeQuery: 'a'.repeat(51) })).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
