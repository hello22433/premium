import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { SettleConfirmationWalletService } from './settle-confirmation-wallet.service';
import { WalletLedgerService } from './wallet-ledger.service';
import { WalletResourceType } from '../interface/wallet-resource-type';

describe('SettleConfirmationWalletService', () => {
  let sut: SettleConfirmationWalletService;
  let repo: any;
  let ledger: jest.Mocked<WalletLedgerService>;

  beforeEach(async () => {
    repo = { findOne: jest.fn() };
    ledger = {
      recordTransaction: jest.fn().mockResolvedValue({ transactionId: 'tx', balanceAfter: 0, isDuplicate: false }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SettleConfirmationWalletService,
        { provide: getRepositoryToken(OrderPaymentAllocationEntity), useValue: repo },
        { provide: getDataSourceToken(), useValue: {} },
        { provide: WalletLedgerService, useValue: ledger },
      ],
    }).compile();
    sut = module.get(SettleConfirmationWalletService);
  });

  it('정산확정 → credit + credit_excess 감소 (settle_release)', async () => {
    repo.findOne.mockResolvedValue({
      walletAccountId: '5',
      creditUsedAmount: 7000,
      creditExcessAmount: 3000,
    } as OrderPaymentAllocationEntity);

    const r = await sut.confirmSettlement(100, 'cycle-1');
    expect(r.creditReleased).toBe(7000);
    expect(r.excessReleased).toBe(3000);
    expect(ledger.recordTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SETTLE_RELEASE',
        resourceType: WalletResourceType.CREDIT,
        amount: -7000,
        idempotencyKey: 'settle_release:100::credit:cycle-1',
      }),
    );
    expect(ledger.recordTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: WalletResourceType.CREDIT_EXCESS,
        amount: -3000,
        idempotencyKey: 'settle_release:100::credit_excess:cycle-1',
      }),
    );
  });

  it('정산해제 → credit + credit_excess 복원 (settle_undo)', async () => {
    repo.findOne.mockResolvedValue({
      walletAccountId: '5',
      creditUsedAmount: 7000,
      creditExcessAmount: 3000,
    } as OrderPaymentAllocationEntity);

    const r = await sut.undoSettlement(100, 'cycle-1');
    expect(r.creditRestored).toBe(7000);
    expect(r.excessRestored).toBe(3000);
    expect(ledger.recordTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SETTLE_UNDO',
        amount: 7000,
        idempotencyKey: 'settle_undo:100::credit:cycle-1',
      }),
    );
  });

  it('allocation 미존재 → BadRequest', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(sut.confirmSettlement(404, 'cycle-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('credit 사용 0 + excess 0 → ledger 호출 없음', async () => {
    repo.findOne.mockResolvedValue({
      walletAccountId: '5',
      creditUsedAmount: 0,
      creditExcessAmount: 0,
    } as OrderPaymentAllocationEntity);
    const r = await sut.confirmSettlement(100, 'cycle-1');
    expect(r.creditReleased).toBe(0);
    expect(r.excessReleased).toBe(0);
    expect(ledger.recordTransaction).not.toHaveBeenCalled();
  });
});
