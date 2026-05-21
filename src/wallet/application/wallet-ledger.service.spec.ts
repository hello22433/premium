import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { WalletResourceType } from '../interface/wallet-resource-type';
import { WalletLedgerService } from './wallet-ledger.service';

describe('WalletLedgerService — idempotency + 한도 invariant + row split', () => {
  let sut: WalletLedgerService;

  // shared state
  let existingTxByKey: Record<string, Partial<WalletTransactionEntity> | undefined>;
  let walletState: Partial<WalletAccountEntity>;
  let txInsertBehavior: 'ok' | 'dup';
  let nextTxId = 1;

  const fakeManager = () => ({
    getRepository: (target: any) => {
      if (target === WalletAccountEntity) {
        return {
          createQueryBuilder: () => ({
            setLock: () => ({
              where: () => ({ getOne: async () => walletState }),
            }),
          }),
        };
      }
      if (target === WalletTransactionEntity) {
        return {
          save: jest.fn(async (row: any) => {
            if (txInsertBehavior === 'dup') {
              const err: any = new QueryFailedError('', [], new Error());
              err.driverError = { code: 'ER_DUP_ENTRY', errno: 1062 };
              throw err;
            }
            return { id: `tx${nextTxId++}`, ...row };
          }),
          findOne: jest.fn(async ({ where }: any) => existingTxByKey[where.idempotencyKey]),
        };
      }
      return { save: jest.fn(), findOne: jest.fn() };
    },
    save: jest.fn(async (target: any, obj: any) => {
      if (target === WalletAccountEntity || obj?.depositBalance != null) {
        walletState = obj;
        return obj;
      }
      return { id: `inserted-${nextTxId++}`, ...obj };
    }),
    findOne: jest.fn(async () => null),
  });

  const fakeDataSource = {
    getRepository: (target: any) => {
      if (target === WalletTransactionEntity) {
        return {
          findOne: jest.fn(async ({ where }: any) => existingTxByKey[where.idempotencyKey]),
        };
      }
      return { findOne: jest.fn() };
    },
    transaction: jest.fn(async (cb: (m: any) => any) => cb(fakeManager())),
  };

  beforeEach(async () => {
    existingTxByKey = {};
    walletState = {
      id: '1',
      depositBalance: 10000,
      creditLimit: 100000,
      creditUsedAmount: 0,
      creditExcessAmount: 0,
    };
    txInsertBehavior = 'ok';
    nextTxId = 1;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletLedgerService,
        { provide: getDataSourceToken(), useValue: fakeDataSource as unknown as DataSource },
      ],
    }).compile();
    sut = module.get(WalletLedgerService);
  });

  it('DEPOSIT 차감 시 wallet_transaction row 생성 + balance after 계산', async () => {
    const r = await sut.recordTransaction({
      walletAccountId: '1',
      type: 'CONFIRM',
      resourceType: WalletResourceType.DEPOSIT,
      amount: -3000,
      idempotencyKey: 'confirm:1:100:deposit',
    });
    expect(r.isDuplicate).toBe(false);
    expect(r.balanceAfter).toBe(7000);
    expect(r.transactionId).toMatch(/^tx/);
  });

  it('fast-path: 이미 처리된 idempotency_key → 잔액 변경 없이 isDuplicate=true', async () => {
    existingTxByKey['confirm:1:100:deposit'] = {
      id: 'tx-existing',
      balanceAfter: 7000,
    };
    const r = await sut.recordTransaction({
      walletAccountId: '1',
      type: 'CONFIRM',
      resourceType: WalletResourceType.DEPOSIT,
      amount: -3000,
      idempotencyKey: 'confirm:1:100:deposit',
    });
    expect(r.isDuplicate).toBe(true);
    expect(r.transactionId).toBe('tx-existing');
    // 잔액 변경 안 됨
    expect(walletState.depositBalance).toBe(10000);
  });

  it('race: insert 시점 UNIQUE 위반 → rollback → 기존 row return', async () => {
    txInsertBehavior = 'dup';
    existingTxByKey['confirm:1:100:deposit'] = {
      id: 'tx-race-winner',
      balanceAfter: 7000,
    };
    const r = await sut.recordTransaction({
      walletAccountId: '1',
      type: 'CONFIRM',
      resourceType: WalletResourceType.DEPOSIT,
      amount: -3000,
      idempotencyKey: 'confirm:1:100:deposit',
    });
    expect(r.isDuplicate).toBe(true);
    expect(r.transactionId).toBe('tx-race-winner');
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

  it('CREDIT 가산 시 한도 invariant 위반 → BadRequestException', async () => {
    walletState = { id: '1', depositBalance: 0, creditLimit: 100000, creditUsedAmount: 95000, creditExcessAmount: 0 };
    await expect(
      sut.recordTransaction({
        walletAccountId: '1',
        type: 'CONFIRM',
        resourceType: WalletResourceType.CREDIT,
        amount: 10000,
        idempotencyKey: 'confirm:1:100:credit',
      }),
    ).rejects.toThrow(/credit_limit_exceeded/);
  });

  it('CREDIT 가산 한도 내 → 잔액 갱신 성공', async () => {
    walletState = { id: '1', depositBalance: 0, creditLimit: 100000, creditUsedAmount: 50000, creditExcessAmount: 0 };
    const r = await sut.recordTransaction({
      walletAccountId: '1',
      type: 'CONFIRM',
      resourceType: WalletResourceType.CREDIT,
      amount: 30000,
      idempotencyKey: 'confirm:1:100:credit',
    });
    expect(r.isDuplicate).toBe(false);
    expect(r.balanceAfter).toBe(80000);
  });

  it('DEPOSIT 차감 시 underflow → BadRequestException', async () => {
    walletState = { id: '1', depositBalance: 1000, creditLimit: 100000, creditUsedAmount: 0, creditExcessAmount: 0 };
    await expect(
      sut.recordTransaction({
        walletAccountId: '1',
        type: 'FAIL_REFUND',
        resourceType: WalletResourceType.DEPOSIT,
        amount: -5000,
        idempotencyKey: 'fail:1:100:deposit',
      }),
    ).rejects.toThrow(/deposit_underflow/);
  });

  it('CREDIT_EXCESS 자원도 wallet_account 잔액 갱신 (한도 검증 X)', async () => {
    walletState = { id: '1', depositBalance: 0, creditLimit: 100000, creditUsedAmount: 100000, creditExcessAmount: 0 };
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
