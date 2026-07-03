import { BadRequestException } from '@nestjs/common';
import { SettlementCodeAdminController } from './settlement-code-admin.controller';

describe('SettlementCodeAdminController', () => {
  let controller: SettlementCodeAdminController;
  let walletReadService: { getSettlementCodeSnapshot: jest.Mock };
  let adminService: {
    issueNewCode: jest.Mock;
    assignUserToCode: jest.Mock;
    renameCode: jest.Mock;
    setCodeCreditLimit: jest.Mock;
    listPendingAccounts: jest.Mock;
  };

  beforeEach(() => {
    walletReadService = { getSettlementCodeSnapshot: jest.fn() };
    adminService = {
      issueNewCode: jest.fn(),
      assignUserToCode: jest.fn(),
      renameCode: jest.fn(),
      setCodeCreditLimit: jest.fn(),
      listPendingAccounts: jest.fn(),
    };
    controller = new SettlementCodeAdminController(walletReadService as any, adminService as any);
  });

  it('GET / → WalletReadService.getSettlementCodeSnapshot(companyId)', () => {
    walletReadService.getSettlementCodeSnapshot.mockReturnValue('snapshot');
    expect(controller.list(7)).toBe('snapshot');
    expect(walletReadService.getSettlementCodeSnapshot).toHaveBeenCalledWith(7);
  });

  it('GET /pending → adminService.listPendingAccounts(companyId)', async () => {
    const payload = { companyId: 7, pendingUsers: [{ userId: 3, personName: 'C' }] };
    adminService.listPendingAccounts.mockResolvedValue(payload);
    const r = await controller.pending(7);
    expect(adminService.listPendingAccounts).toHaveBeenCalledWith(7);
    expect(r).toBe(payload);
  });

  it('GET /accounts → 스냅샷에서 해당 코드 필터', async () => {
    walletReadService.getSettlementCodeSnapshot.mockResolvedValue({
      settlementCodes: [
        { settlementCode: 'company-7', assignedUsers: [] },
        { settlementCode: 'company-7-1', assignedUsers: [{ userId: 2, personName: 'B' }] },
      ],
    });
    const r = await controller.accounts(7, 'company-7-1');
    expect(r.settlementCode).toBe('company-7-1');
  });

  it('GET /accounts → 코드 없으면 BadRequest', async () => {
    walletReadService.getSettlementCodeSnapshot.mockResolvedValue({ settlementCodes: [] });
    await expect(controller.accounts(7, 'company-999')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('GET /accounts → settlementCode 빈값이면 BadRequest', async () => {
    await expect(controller.accounts(7, '  ')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST /issue → adminService.issueNewCode(userId)', async () => {
    adminService.issueNewCode.mockResolvedValue('company-7-2');
    const r = await controller.issue({ userId: 3 });
    expect(adminService.issueNewCode).toHaveBeenCalledWith(3);
    expect(r).toEqual({ settlementCode: 'company-7-2' });
  });

  it('PUT /assign → adminService.assignUserToCode(userId, settlementCode)', async () => {
    const r = await controller.assign({ userId: 3, settlementCode: 'company-7-1' });
    expect(adminService.assignUserToCode).toHaveBeenCalledWith(3, 'company-7-1');
    expect(r).toEqual({ success: true });
  });

  it('PUT /rename → adminService.renameCode(companyId, oldCode, newCode)', async () => {
    const r = await controller.rename({ companyId: 7, oldCode: 'company-7', newCode: 'company-7-x' });
    expect(adminService.renameCode).toHaveBeenCalledWith(7, 'company-7', 'company-7-x');
    expect(r).toEqual({ success: true });
  });

  it('PUT /credit-limit → adminService.setCodeCreditLimit(settlementCode, creditLimit, operator)', async () => {
    const operator = { id: 99, email: 'op@test.com', authority: 'OPERATION_ADMIN' } as any;
    adminService.setCodeCreditLimit.mockResolvedValue({ settlementCode: 'company-7', before: 0, after: 100 });
    await controller.setCreditLimit(operator, { settlementCode: 'company-7', creditLimit: 100 });
    expect(adminService.setCodeCreditLimit).toHaveBeenCalledWith('company-7', 100, operator);
  });
});
