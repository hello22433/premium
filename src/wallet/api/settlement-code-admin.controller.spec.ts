import { BadRequestException } from '@nestjs/common';
import { CreateCodeReqDto, SettlementCodeAdminController } from './settlement-code-admin.controller';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

describe('SettlementCodeAdminController', () => {
  let controller: SettlementCodeAdminController;
  let walletReadService: { getSettlementCodeSnapshot: jest.Mock; getSettlementCodeDetail: jest.Mock };
  let adminService: {
    issueNewCode: jest.Mock;
    createCodeForCompany: jest.Mock;
    assignUserToCode: jest.Mock;
    renameCode: jest.Mock;
    setCodeCreditLimit: jest.Mock;
    listPendingAccounts: jest.Mock;
    chargeDeposit: jest.Mock;
    getCodeHistory: jest.Mock;
    getDepositHistory: jest.Mock;
    setSettlePolicy: jest.Mock;
  };

  beforeEach(() => {
    walletReadService = { getSettlementCodeSnapshot: jest.fn(), getSettlementCodeDetail: jest.fn() };
    adminService = {
      issueNewCode: jest.fn(),
      createCodeForCompany: jest.fn(),
      assignUserToCode: jest.fn(),
      renameCode: jest.fn(),
      setCodeCreditLimit: jest.fn(),
      listPendingAccounts: jest.fn(),
      chargeDeposit: jest.fn(),
      getCodeHistory: jest.fn(),
      getDepositHistory: jest.fn(),
      setSettlePolicy: jest.fn(),
    };
    controller = new SettlementCodeAdminController(walletReadService as any, adminService as any);
  });

  it('GET / → WalletReadService.getSettlementCodeSnapshot(companyId)', () => {
    walletReadService.getSettlementCodeSnapshot.mockReturnValue('snapshot');
    expect(controller.list(7)).toBe('snapshot');
    expect(walletReadService.getSettlementCodeSnapshot).toHaveBeenCalledWith(7);
  });

  it('GET /detail → companyId를 포함해 rename 판단을 위임한다', () => {
    walletReadService.getSettlementCodeDetail.mockReturnValue('detail');
    expect(controller.detail('nvida', 7)).toBe('detail');
    expect(walletReadService.getSettlementCodeDetail).toHaveBeenCalledWith('nvida', 7);
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

  it('POST / → 사용자 지정 코드를 정책/한도와 함께 생성한다', async () => {
    adminService.createCodeForCompany.mockResolvedValue('nvida');
    const r = await controller.create({
      companyId: 7,
      settlementCode: 'nvida',
      settleCondition: 'PRE_PAYMENT',
      settleMethod: 'CARD',
      cardSurchargeApplied: false,
      creditLimit: 5000,
    });
    expect(adminService.createCodeForCompany).toHaveBeenCalledWith(7, 'nvida', {
      settleCondition: 'PRE_PAYMENT',
      settleMethod: 'CARD',
      cardSurchargeApplied: false,
      creditLimit: 5000,
    });
    expect(r).toEqual({ settlementCode: 'nvida' });
  });

  it('CreateCodeReqDto → trim 후 길이와 제어문자를 검증한다', async () => {
    const valid = plainToInstance(CreateCodeReqDto, { companyId: 7, settlementCode: '  한글-code_1  ' });
    expect(valid.settlementCode).toBe('한글-code_1');
    await expect(validate(valid)).resolves.toHaveLength(0);
    const boundary = plainToInstance(CreateCodeReqDto, { companyId: 7, settlementCode: ` ${'x'.repeat(50)} ` });
    expect(boundary.settlementCode).toBe('x'.repeat(50));
    await expect(validate(boundary)).resolves.toHaveLength(0);

    for (const settlementCode of [
      undefined,
      '   ',
      'x'.repeat(51),
      'line\nbreak',
      'tab\tcode',
      `nul${String.fromCharCode(0)}code`,
    ]) {
      const dto = plainToInstance(CreateCodeReqDto, { companyId: 7, settlementCode });
      expect(await validate(dto)).not.toHaveLength(0);
    }
  });

  it('PUT /assign → adminService.assignUserToCode(userId, settlementCode)', async () => {
    const r = await controller.assign({ userId: 3, settlementCode: 'company-7-1' });
    expect(adminService.assignUserToCode).toHaveBeenCalledWith(3, 'company-7-1');
    expect(r).toEqual({ success: true });
  });

  it('PUT /rename → adminService.renameCode(companyId, oldCode, newCode, operator)', async () => {
    const operator = { id: 99, email: 'op@test.com', authority: 'OPERATION_ADMIN' } as any;
    const r = await controller.rename(operator, { companyId: 7, oldCode: 'company-7', newCode: 'company-7-x' });
    expect(adminService.renameCode).toHaveBeenCalledWith(7, 'company-7', 'company-7-x', operator);
    expect(r).toEqual({ success: true });
  });

  it('PUT /credit-limit → adminService.setCodeCreditLimit(settlementCode, creditLimit, operator)', async () => {
    const operator = { id: 99, email: 'op@test.com', authority: 'OPERATION_ADMIN' } as any;
    adminService.setCodeCreditLimit.mockResolvedValue({ settlementCode: 'company-7', before: 0, after: 100 });
    await controller.setCreditLimit(operator, { settlementCode: 'company-7', creditLimit: 100 });
    expect(adminService.setCodeCreditLimit).toHaveBeenCalledWith('company-7', 100, operator);
  });

  it('POST /deposits → adminService.chargeDeposit(code, amount, operator, memo, requestKey)', async () => {
    const operator = { id: 99, email: 'op@test.com' } as any;
    await controller.deposit(operator, {
      settlementCode: 'company-7',
      chargeAmount: 5000,
      memo: '충전',
      requestKey: 'req-1',
    } as any);
    expect(adminService.chargeDeposit).toHaveBeenCalledWith('company-7', 5000, operator, '충전', 'req-1');
  });

  it('GET /history → getCodeHistory(code, { limit, cursor, eventType }) — limit 숫자 변환', () => {
    controller.history('company-7', '30', 'CUR', 'SETTLE_POLICY_CHANGED' as any);
    expect(adminService.getCodeHistory).toHaveBeenCalledWith('company-7', {
      limit: 30,
      cursor: 'CUR',
      eventType: 'SETTLE_POLICY_CHANGED',
    });
  });

  it('GET /history → limit 미지정 시 undefined 전달', () => {
    controller.history('company-7');
    expect(adminService.getCodeHistory).toHaveBeenCalledWith('company-7', {
      limit: undefined,
      cursor: undefined,
      eventType: undefined,
    });
  });

  it('GET /deposits → getDepositHistory(code, { limit, cursor })', () => {
    controller.depositHistory('company-7', '50', 'CUR');
    expect(adminService.getDepositHistory).toHaveBeenCalledWith('company-7', { limit: 50, cursor: 'CUR' });
  });
});
