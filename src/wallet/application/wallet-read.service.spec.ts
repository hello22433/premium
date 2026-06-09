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
  for (const m of ['select', 'addSelect', 'where', 'andWhere', 'orderBy']) {
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
        { provide: getRepositoryToken(WalletAccountEntity), useValue: { findOne: jest.fn() } },
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
  });

  describe('getSettlementCodeSnapshot', () => {
    it('다중 settlementCode → 코드별 분리 + 잔액/포인트', async () => {
      userRepo.createQueryBuilder.mockReturnValue(
        makeQb([{ settlementCode: 'company-7' }, { settlementCode: 'company-7-mkt' }]),
      );
      walletRepo.findOne.mockImplementation(
        async ({ where }: any) =>
          (where.ownerId === 'company-7'
            ? { id: '11', depositBalance: 5000, creditLimit: 100000, creditUsedAmount: 2000, creditExcessAmount: 0 }
            : { id: '22', depositBalance: 0, creditLimit: 50000, creditUsedAmount: 0, creditExcessAmount: 300 }) as any,
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
      });
      expect(res.settlementCodes[0].assignedUsers).toHaveLength(1);
      expect(pointRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('point SUM 은 만료/비활성/소진 제외 필터 적용', async () => {
      userRepo.createQueryBuilder.mockReturnValue(makeQb([{ settlementCode: 'company-7' }]));
      walletRepo.findOne.mockResolvedValue({ id: '11', depositBalance: 0, creditLimit: 0, creditUsedAmount: 0, creditExcessAmount: 0 } as any);
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
      const allocQb = makeQb({ walletPaidAmount: '0', depositUsedAmount: '0', creditUsedAmount: '0', creditExcessAmount: '0', pointUsedAmount: '0', orderCount: '0' });
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

    it('from/to 누락 → BadRequestException', async () => {
      await expect(sut.getSettlementCodeUsage(7, '', '2026-06-30', false)).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
