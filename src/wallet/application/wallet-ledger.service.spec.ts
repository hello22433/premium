import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { PointGrantEntity } from '../../entity/point.grant.entity';
import { WalletResourceType } from '../interface/wallet-resource-type';
import { WalletLedgerService } from './wallet-ledger.service';

describe('WalletLedgerService — idempotency_key UNIQUE + row split', () => {
  let sut: WalletLedgerService;
  let mockManager: any;
  let mockTransactionFn: jest.Mock;

  const wallet = (overrides: Partial<WalletAccountEntity> = {}): WalletAccountEntity =>
    ({
      id: '1',
      ownerType: 'SETTLEMENT_CODE',
      ownerId: 'company-1',
      depositBalance: 10000,
      creditLimit: 100000,
      creditUsedAmount: 0,
      creditExcessAmount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as WalletAccountEntity;

  beforeEach(async () => {
    const txQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };
    const walletSavedRef: { value: WalletAccountEntity | null } = { value: null };
    const txRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(txQb),
      save: jest.fn(),
      findOne: jest.fn(),
    };
    mockManager = {
      getRepository: jest.fn((target: any) => {
        if (target === WalletAccountEntity) {
          return {
            createQueryBuilder: () => ({
              ...txQb,
              getOne: () => walletSavedRef.value ?? wallet(),
            }),
          };
        }
        if (target === WalletTransactionEntity) return txRepo;
        return { save: jest.fn() };
      }),
      save: jest.fn(async (_target: any, obj: any) => {
        if (_target === WalletAccountEntity || obj?.depositBalance != null) {
          walletSavedRef.value = obj;
          return obj;
        }
        return { id: 'g1', ...obj };
      }),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    mockTransactionFn = jest.fn(async (cb: (m: any) => any) => cb(mockManager));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletLedgerService,
        { provide: getDataSourceToken(), useValue: { transaction: mockTransactionFn } as Partial<DataSource> },
      ],
    }).compile();
    sut = module.get(WalletLedgerService);
  });

  it('DEPOSIT 차감 시 wallet_transaction row 생성', async () => {
    const w = wallet({ depositBalance: 10000 });
    mockManager.getRepository = jest.fn((t: any) => {
      if (t === WalletAccountEntity) {
        return {
          createQueryBuilder: () => ({
            setLock: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            getOne: () => w,
          }),
        };
      }
      if (t === WalletTransactionEntity) {
        return { save: jest.fn(async (row: any) => ({ id: 'tx1', ...row })) };
      }
      return { save: jest.fn() };
    });
    mockManager.save = jest.fn(async (_target: any, obj: any) => obj ?? _target);

    const r = await sut.recordTransaction({
      walletAccountId: '1',
      type: 'CONFIRM',
      resourceType: WalletResourceType.DEPOSIT,
      amount: -3000,
      idempotencyKey: 'confirm:1:100:deposit',
    });
    expect(r.transactionId).toBe('tx1');
    expect(r.balanceAfter).toBe(7000);
    expect(r.isDuplicate).toBe(false);
  });

  it('idempotency_key 중복 (ER_DUP_ENTRY) → success no-op + isDuplicate=true', async () => {
    const w = wallet();
    const existing = { id: 'tx-existing', balanceAfter: 7000 } as WalletTransactionEntity;
    const txRepo = {
      save: jest.fn().mockRejectedValue(
        Object.assign(new QueryFailedError('', [], new Error()), {
          driverError: { code: 'ER_DUP_ENTRY', errno: 1062 },
        }),
      ),
      findOne: jest.fn().mockResolvedValue(existing),
    };
    mockManager.getRepository = jest.fn((t: any) => {
      if (t === WalletAccountEntity) {
        return {
          createQueryBuilder: () => ({
            setLock: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            getOne: () => w,
          }),
        };
      }
      if (t === WalletTransactionEntity) return txRepo;
      return { save: jest.fn() };
    });
    mockManager.save = jest.fn(async (_t: any, obj: any) => obj);

    const r = await sut.recordTransaction({
      walletAccountId: '1',
      type: 'CONFIRM',
      resourceType: WalletResourceType.DEPOSIT,
      amount: -3000,
      idempotencyKey: 'confirm:1:100:deposit',
    });
    expect(r.isDuplicate).toBe(true);
    expect(r.transactionId).toBe('tx-existing');
  });

  it('POINT 자원 + point_grant_id 누락 → 에러', async () => {
    await expect(
      sut.recordTransaction({
        walletAccountId: '1',
        type: 'CONFIRM',
        resourceType: WalletResourceType.POINT,
        amount: -1000,
        idempotencyKey: 'confirm:1:100:point',
      }),
    ).rejects.toThrow('point_grant_id required');
  });

  it('CREDIT_EXCESS 자원도 wallet_account 잔액 갱신', async () => {
    const w = wallet({ creditExcessAmount: 0 });
    mockManager.getRepository = jest.fn((t: any) => {
      if (t === WalletAccountEntity) {
        return {
          createQueryBuilder: () => ({
            setLock: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            getOne: () => w,
          }),
        };
      }
      if (t === WalletTransactionEntity) {
        return { save: jest.fn(async (row: any) => ({ id: 'tx2', ...row })) };
      }
      return { save: jest.fn() };
    });
    mockManager.save = jest.fn(async (_t: any, obj: any) => obj);

    const r = await sut.recordTransaction({
      walletAccountId: '1',
      type: 'CONFIRM',
      resourceType: WalletResourceType.CREDIT_EXCESS,
      amount: 5000,
      idempotencyKey: 'confirm:1:100:credit_excess',
    });
    expect(r.balanceAfter).toBe(5000);
  });
});
