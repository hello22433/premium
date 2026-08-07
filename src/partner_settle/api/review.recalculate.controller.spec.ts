import { NotFoundException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { ReviewRecalculateController } from './review.recalculate.controller';
import { ReviewRecalculateReqDto } from './dto/review.recalculate.dto';

const user = { id: 42 } as never;

function build(enabled = true) {
  const recalculateService = { recalculate: jest.fn().mockResolvedValue({ succeeded: [], failed: [] }) };
  const authService = { authorityValidator: jest.fn().mockResolvedValue(undefined) };
  const featureFlag = { isReviewResolutionEnabled: enabled };
  const controller = new ReviewRecalculateController(
    recalculateService as never,
    authService as never,
    featureFlag as never,
  );
  return { controller, recalculateService, authService };
}

async function errorsFor(body: Record<string, unknown>) {
  return validate(plainToInstance(ReviewRecalculateReqDto, body), { whitelist: true, forbidNonWhitelisted: true });
}

describe('ReviewRecalculateController', () => {
  it('fails closed before authorization and service invocation', async () => {
    const { controller, recalculateService, authService } = build(false);

    await expect(controller.recalculate(user, { ledgerIds: [1] })).rejects.toBeInstanceOf(NotFoundException);
    expect(authService.authorityValidator).not.toHaveBeenCalled();
    expect(recalculateService.recalculate).not.toHaveBeenCalled();
  });

  it('checks SETTLE_PARTNER_CONFIRM and delegates ledger IDs with actor ID', async () => {
    const { controller, recalculateService, authService } = build();

    await controller.recalculate(user, { ledgerIds: [1, 2] });

    expect(authService.authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    expect(recalculateService.recalculate).toHaveBeenCalledWith({ ledgerIds: [1, 2] }, 42);
  });

  it('delegates partner company target and optional sub-item key', async () => {
    const { controller, recalculateService } = build();

    await controller.recalculate(user, { partnerCompanyId: 7, subItemKey: 'gift-show:123' });

    expect(recalculateService.recalculate).toHaveBeenCalledWith(
      { partnerCompanyId: 7, subItemKey: 'gift-show:123' },
      42,
    );
  });

  it('declares the deterministic recalculate route', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ReviewRecalculateController)).toBe('settle/ledger/needs-review');
    expect(Reflect.getMetadata(PATH_METADATA, ReviewRecalculateController.prototype.recalculate)).toBe('recalculate');
  });

  it('accepts exactly one recalculation target mode', async () => {
    await expect(errorsFor({ ledgerIds: ['1', 2] })).resolves.toHaveLength(0);
    await expect(errorsFor({ partnerCompanyId: '7', subItemKey: 'gift-show:123' })).resolves.toHaveLength(0);
  });

  it('rejects ambiguous, missing, and unsupported target modes', async () => {
    await expect(errorsFor({ ledgerIds: [1], partnerCompanyId: 7 })).resolves.not.toHaveLength(0);
    await expect(errorsFor({})).resolves.not.toHaveLength(0);
    await expect(errorsFor({ partnerCompanyId: 7, resolutionMode: 'DISCARD' })).resolves.not.toHaveLength(0);
  });
});
