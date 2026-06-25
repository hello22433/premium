import { NotFoundException } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { LegacyWalletCreditSyncService } from './legacy-wallet-credit-sync.service';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { UserEntity } from '../../entity/user.entity';
import { WalletResourceType } from '../interface/wallet-resource-type';

/**
 * 레거시 wallet 여신 동기화 단위 테스트.
 * EntityManager 를 목으로 대체해 credit_used 증감 / 멱등키 seq / 클램프 / throw 를 검증한다.
 */
function makeManager(opts: {
  user: { id: number; settlementCode: string } | null;
  wallet: { id: string | number; creditUsedAmount: number } | null;
  txCount?: number;
}) {
  const saved = { wallets: [] as any[], txs: [] as any[] };
  const walletQb: any = {
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(opts.wallet),
  };
  const manager: any = {
    getRepository: jest.fn((entity: any) => {
      if (entity === UserEntity) {
        return { findOne: jest.fn().mockResolvedValue(opts.user) };
      }
      if (entity === WalletAccountEntity) {
        return { createQueryBuilder: jest.fn().mockReturnValue(walletQb) };
      }
      if (entity === WalletTransactionEntity) {
        return { count: jest.fn().mockResolvedValue(opts.txCount ?? 0) };
      }
      return {};
    }),
    save: jest.fn((entity: any, obj: any) => {
      if (entity === WalletAccountEntity) saved.wallets.push(obj);
      else saved.txs.push(obj);
      return Promise.resolve(obj);
    }),
  };
  return { manager, saved, walletQb };
}

describe('LegacyWalletCreditSyncService', () => {
  let sut: LegacyWalletCreditSyncService;

  beforeEach(() => {
    sut = new LegacyWalletCreditSyncService();
    jest.restoreAllMocks();
  });

  const baseParams = {
    billingUserId: 97,
    orderId: 5169,
    delta: 0,
    type: 'SETTLE_RELEASE' as const,
    memo: 'test',
  };

  it('delta<0 → credit_used 차감 + CREDIT 트랜잭션(amount 음수, balanceAfter 갱신)', async () => {
    const { manager, saved } = makeManager({
      user: { id: 97, settlementCode: 'company-35' },
      wallet: { id: 33, creditUsedAmount: 100000 },
    });

    await sut.syncCredit(manager, { ...baseParams, delta: -30000, type: 'SETTLE_RELEASE' });

    expect(saved.wallets[0].creditUsedAmount).toBe(70000);
    expect(saved.txs[0]).toMatchObject({
      walletAccountId: '33',
      orderId: 5169,
      orderDeliveryId: null,
      type: 'SETTLE_RELEASE',
      resourceType: WalletResourceType.CREDIT,
      amount: -30000,
      balanceAfter: 70000,
      idempotencyKey: 'legacy_settle_release:5169:credit:0',
    });
  });

  it('delta>0 → credit_used 가산 (SETTLE_UNDO)', async () => {
    const { manager, saved } = makeManager({
      user: { id: 97, settlementCode: 'company-35' },
      wallet: { id: 33, creditUsedAmount: 70000 },
    });

    await sut.syncCredit(manager, { ...baseParams, delta: 30000, type: 'SETTLE_UNDO' });

    expect(saved.wallets[0].creditUsedAmount).toBe(100000);
    expect(saved.txs[0]).toMatchObject({ type: 'SETTLE_UNDO', amount: 30000, balanceAfter: 100000 });
  });

  it('delta=0 → no-op (wallet/tx 미저장)', async () => {
    const { manager, saved } = makeManager({
      user: { id: 97, settlementCode: 'company-35' },
      wallet: { id: 33, creditUsedAmount: 100000 },
    });

    await sut.syncCredit(manager, { ...baseParams, delta: 0 });

    expect(saved.wallets).toHaveLength(0);
    expect(saved.txs).toHaveLength(0);
  });

  it('orderDeliveryId 지정 시 멱등키 keyBase 에 deliveryId 포함', async () => {
    const { manager, saved } = makeManager({
      user: { id: 97, settlementCode: 'company-35' },
      wallet: { id: 33, creditUsedAmount: 50000 },
      txCount: 0,
    });

    await sut.syncCredit(manager, {
      ...baseParams,
      orderDeliveryId: 9001,
      delta: -10000,
      type: 'FAIL_REFUND',
    });

    expect(saved.txs[0].orderDeliveryId).toBe(9001);
    expect(saved.txs[0].idempotencyKey).toBe('legacy_fail_refund:5169:9001:credit:0');
  });

  it('동일 prefix 기존 tx 수(seq)로 멱등키 suffix 증가', async () => {
    const { manager, saved } = makeManager({
      user: { id: 97, settlementCode: 'company-35' },
      wallet: { id: 33, creditUsedAmount: 50000 },
      txCount: 2,
    });

    await sut.syncCredit(manager, { ...baseParams, delta: -10000, type: 'SETTLE_RELEASE' });

    expect(saved.txs[0].idempotencyKey).toBe('legacy_settle_release:5169:credit:2');
  });

  it('credit_used 음수 발생 시 0 클램프 + applied 보정 + error 로그', async () => {
    const errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { manager, saved } = makeManager({
      user: { id: 97, settlementCode: 'company-35' },
      wallet: { id: 33, creditUsedAmount: 100 },
    });

    await sut.syncCredit(manager, { ...baseParams, delta: -500, type: 'DISCARD_REFUND' });

    expect(saved.wallets[0].creditUsedAmount).toBe(0);
    expect(saved.txs[0].amount).toBe(-100); // applied = clamped(0) - before(100)
    expect(saved.txs[0].balanceAfter).toBe(0);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain('settlementCode=company-35');
  });

  it('settlement_code 미존재 → NotFoundException', async () => {
    const { manager } = makeManager({
      user: { id: 97, settlementCode: '' },
      wallet: { id: 33, creditUsedAmount: 100000 },
    });

    await expect(sut.syncCredit(manager, { ...baseParams, delta: -1000 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('wallet_account 미존재 → NotFoundException', async () => {
    const { manager } = makeManager({
      user: { id: 97, settlementCode: 'company-35' },
      wallet: null,
    });

    await expect(sut.syncCredit(manager, { ...baseParams, delta: -1000 })).rejects.toBeInstanceOf(NotFoundException);
  });
});
