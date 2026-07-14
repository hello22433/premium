import { NotFoundException } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { LegacyWalletCreditSyncService } from './legacy-wallet-credit-sync.service';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { UserEntity } from '../../entity/user.entity';
import { WalletResourceType } from '../interface/wallet-resource-type';

/**
 * 레거시 wallet 여신/예치금 동기화 단위 테스트.
 * EntityManager 를 목으로 대체해 credit_used 증감 / 멱등키 seq / 클램프 / throw 를 검증하고(syncCredit),
 * 예치금은 WalletLedgerService.recordTransaction(DEPOSIT) 위임 계약을 검증한다(syncDeposit).
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
        return {
          createQueryBuilder: jest.fn().mockReturnValue(walletQb),
          findOne: jest.fn().mockResolvedValue(opts.wallet),
        };
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

function makeWalletLedger() {
  return {
    recordTransaction: jest.fn().mockResolvedValue({ transactionId: 'tx-1', balanceAfter: 0, isDuplicate: false }),
  };
}

describe('LegacyWalletCreditSyncService', () => {
  let sut: LegacyWalletCreditSyncService;
  let walletLedger: ReturnType<typeof makeWalletLedger>;

  beforeEach(() => {
    walletLedger = makeWalletLedger();
    sut = new LegacyWalletCreditSyncService(walletLedger as any);
    jest.restoreAllMocks();
  });

  const baseParams = {
    billingUserId: 97,
    orderId: 5169,
    delta: 0,
    type: 'SETTLE_RELEASE' as const,
    memo: 'test',
  };

  describe('syncCredit', () => {
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

  describe('syncDeposit', () => {
    const depParams = {
      billingUserId: 97,
      orderId: 5169,
      orderDeliveryId: 9001,
      delta: 0,
      type: 'DISCARD_REFUND' as const,
      idempotencyKey: 'legacy_discard_refund:5169:9001:deposit',
      memo: 'legacy deposit refund',
    };

    it('delta>0 → recordTransaction(DEPOSIT, +) 위임 (결정론 idempotencyKey passthrough)', async () => {
      const { manager } = makeManager({
        user: { id: 97, settlementCode: 'company-2' },
        wallet: { id: 33, creditUsedAmount: 0 },
      });

      await sut.syncDeposit(manager, { ...depParams, delta: 100000 });

      expect(walletLedger.recordTransaction).toHaveBeenCalledTimes(1);
      expect(walletLedger.recordTransaction).toHaveBeenCalledWith(
        {
          walletAccountId: '33',
          orderId: 5169,
          orderDeliveryId: 9001,
          type: 'DISCARD_REFUND',
          resourceType: WalletResourceType.DEPOSIT,
          amount: 100000,
          memo: 'legacy deposit refund',
          idempotencyKey: 'legacy_discard_refund:5169:9001:deposit',
        },
        manager,
      );
    });

    it('delta<0 → recordTransaction(DEPOSIT, -) 위임 (재발송 역환불 재차감)', async () => {
      const { manager } = makeManager({
        user: { id: 97, settlementCode: 'company-2' },
        wallet: { id: 33, creditUsedAmount: 0 },
      });

      await sut.syncDeposit(manager, {
        ...depParams,
        delta: -30000,
        type: 'RESEND_DEDUCT',
        idempotencyKey: 'legacy_resend_deduct:5169:9001:deposit',
      });

      expect(walletLedger.recordTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ resourceType: WalletResourceType.DEPOSIT, amount: -30000, type: 'RESEND_DEDUCT' }),
        manager,
      );
    });

    it('delta=0 → no-op (recordTransaction 미호출)', async () => {
      const { manager } = makeManager({
        user: { id: 97, settlementCode: 'company-2' },
        wallet: { id: 33, creditUsedAmount: 0 },
      });

      await sut.syncDeposit(manager, { ...depParams, delta: 0 });

      expect(walletLedger.recordTransaction).not.toHaveBeenCalled();
    });

    it('orderDeliveryId 미지정 → null 로 위임', async () => {
      const { manager } = makeManager({
        user: { id: 97, settlementCode: 'company-2' },
        wallet: { id: 33, creditUsedAmount: 0 },
      });

      await sut.syncDeposit(manager, {
        billingUserId: 97,
        orderId: 5169,
        delta: 5000,
        type: 'FAIL_REFUND',
        idempotencyKey: 'legacy_fail_refund:5169:deposit',
        memo: 'x',
      });

      expect(walletLedger.recordTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ orderDeliveryId: null }),
        manager,
      );
    });

    it('settlement_code 미존재 → NotFoundException, recordTransaction 미호출', async () => {
      const { manager } = makeManager({
        user: { id: 97, settlementCode: '' },
        wallet: { id: 33, creditUsedAmount: 0 },
      });

      await expect(sut.syncDeposit(manager, { ...depParams, delta: 100000 })).rejects.toBeInstanceOf(NotFoundException);
      expect(walletLedger.recordTransaction).not.toHaveBeenCalled();
    });

    it('wallet_account 미존재 → NotFoundException, recordTransaction 미호출', async () => {
      const { manager } = makeManager({
        user: { id: 97, settlementCode: 'company-2' },
        wallet: null,
      });

      await expect(sut.syncDeposit(manager, { ...depParams, delta: 100000 })).rejects.toBeInstanceOf(NotFoundException);
      expect(walletLedger.recordTransaction).not.toHaveBeenCalled();
    });
  });
});
