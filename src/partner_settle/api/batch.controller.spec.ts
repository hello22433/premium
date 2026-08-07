import { NotFoundException } from '@nestjs/common';
import { BatchController } from './batch.controller';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

const user = { id: 42, authority: 'SUPER_ADMIN' } as any;

function build(confirmEnabled = true) {
  const batchService = {
    confirm: jest.fn().mockResolvedValue({ batchId: 1, confirmedTotalAmount: '100', confirmedCount: 5 }),
    unconfirm: jest.fn().mockResolvedValue({ releasedCount: 3, requestId: 1 }),
    findBatches: jest.fn().mockResolvedValue([]),
    findBatch: jest.fn().mockResolvedValue({ id: 1 }),
    holdRelease: jest.fn().mockResolvedValue(undefined),
  };
  const paymentService = {
    paid: jest.fn().mockResolvedValue({ statusCode: 200, result: { status: 'PAID' } }),
  };
  const authService = { authorityValidator: jest.fn().mockResolvedValue(undefined) };
  const featureFlag = { isConfirmEnabled: confirmEnabled, isPaidEnabled: false };
  const controller = new BatchController(batchService as any, paymentService as any, authService as any, featureFlag as any);
  return { controller, batchService, paymentService, authService, featureFlag };
}

describe('BatchController', () => {
  it('confirm: checks SETTLE_PARTNER_CONFIRM and delegates to service', async () => {
    const { controller, batchService, authService } = build();
    const body = { partnerCompanyId: 1, periodEnd: '2026-08-01', requestKey: 'key-1' };
    await controller.confirm(user, body);

    expect(authService.authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    expect(batchService.confirm).toHaveBeenCalledWith(body, 42);
  });

  it('confirm: throws 404 when flag is off', async () => {
    const { controller } = build(false);
    await expect(
      controller.confirm(user, { partnerCompanyId: 1, periodEnd: '2026-08-01', requestKey: 'key-1' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('unconfirm: checks authority and delegates', async () => {
    const { controller, batchService, authService } = build();
    const body = { requestKey: 'key-2', reason: '사유', ledgerIds: [1, 2, 3] };
    await controller.unconfirm(user, 5, body);

    expect(authService.authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    expect(batchService.unconfirm).toHaveBeenCalledWith(5, body, 42);
  });

  it('holdRelease: checks authority and delegates', async () => {
    const { controller, batchService, authService } = build();
    await controller.holdRelease(user, 10, { reason: '분쟁 해소' });

    expect(authService.authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    expect(batchService.holdRelease).toHaveBeenCalledWith(10, '분쟁 해소', 42);
  });

  it('findBatches: delegates query', async () => {
    const { controller, batchService } = build();
    await controller.findBatches(user, { partnerCompanyId: 1 });
    expect(batchService.findBatches).toHaveBeenCalledWith({ partnerCompanyId: 1 });
  });
});
