// 인증 가드 import 체인이 date-fns 등 외부 모듈을 끌어오는 것을 차단.
// 컨트롤러 단위 테스트는 가드 동작 자체를 검사하지 않는다.
jest.mock('../../auth/api/auth.user.super-operation-admin.guard', () => ({
  AuthUserSuperAndOperationAdminGuard: class {
    canActivate(): boolean {
      return true;
    }
  },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { WalletAdminController } from './wallet.admin.controller';
import { WalletAccountResolverService } from '../application/wallet-account-resolver.service';
import { WalletLedgerService } from '../application/wallet-ledger.service';
import { CreditExcessApprovalService } from '../application/credit-excess-approval.service';
import { CreditExcessApprovalStatus } from '../../entity/credit.excess.approval.entity';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { IUserAuthority } from '../../user/interface/user.authority';

describe('WalletAdminController', () => {
  let sut: WalletAdminController;
  let resolver: jest.Mocked<WalletAccountResolverService>;
  let ledger: jest.Mocked<WalletLedgerService>;
  let approval: jest.Mocked<CreditExcessApprovalService>;

  const user: ILoginUserInfo = { id: 99, email: 'admin@example.com', authority: IUserAuthority.OPERATION_ADMIN };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WalletAdminController],
      providers: [
        {
          provide: WalletAccountResolverService,
          useValue: { resolveBySettlementCode: jest.fn() },
        },
        { provide: WalletLedgerService, useValue: { issueGrant: jest.fn() } },
        { provide: CreditExcessApprovalService, useValue: { approve: jest.fn(), reject: jest.fn() } },
      ],
    }).compile();
    sut = module.get(WalletAdminController);
    resolver = module.get(WalletAccountResolverService);
    ledger = module.get(WalletLedgerService);
    approval = module.get(CreditExcessApprovalService);
  });

  it('grants POST → resolver 조회 후 issueGrant 호출 + idempotency 전달', async () => {
    resolver.resolveBySettlementCode.mockResolvedValue({ id: '5' } as any);
    ledger.issueGrant.mockResolvedValue({ grantId: 'g1', isDuplicate: false });

    const r = await sut.issueGrant({
      settlementCode: 'company-7',
      amount: 10000,
      reason: '프로모션',
      idempotencyKey: 'grant:promo-2026-05-21:7',
    });
    expect(r).toEqual({ grantId: 'g1', isDuplicate: false });
    expect(ledger.issueGrant).toHaveBeenCalledWith(
      expect.objectContaining({ walletAccountId: '5', amount: 10000, idempotencyKey: 'grant:promo-2026-05-21:7' }),
    );
  });

  it('credit-excess-approval/:id/approve → approve(approvalId, user.id) 호출', async () => {
    approval.approve.mockResolvedValue({
      status: CreditExcessApprovalStatus.APPROVED,
      approvedAt: new Date('2026-05-21'),
    } as any);
    const r = await sut.approveCreditExcess('a1', {}, user);
    expect(approval.approve).toHaveBeenCalledWith('a1', 99);
    expect(r.status).toBe(CreditExcessApprovalStatus.APPROVED);
  });

  it('credit-excess-approval/:id/reject → reject(approvalId, user.id, reason) 호출', async () => {
    approval.reject.mockResolvedValue({
      status: CreditExcessApprovalStatus.REJECTED,
      approvedAt: new Date('2026-05-21'),
      rejectReason: '한도 부족',
    } as any);
    const r = await sut.rejectCreditExcess('a1', { rejectReason: '한도 부족' }, user);
    expect(approval.reject).toHaveBeenCalledWith('a1', 99, '한도 부족');
    expect(r.rejectReason).toBe('한도 부족');
  });
});
