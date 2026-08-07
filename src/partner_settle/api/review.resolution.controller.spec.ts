import { PATH_METADATA } from '@nestjs/common/constants';
import { NotFoundException } from '@nestjs/common';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { ReviewResolutionController } from './review.resolution.controller';

const user = { id: 42 } as never;

function build(enabled = true) {
  const resolutionService = {
    propose: jest.fn().mockResolvedValue({ proposal: {}, ledgerIds: [] }),
    approve: jest.fn().mockResolvedValue({ proposal: {}, ledgerIds: [] }),
    reject: jest.fn().mockResolvedValue({ proposal: {}, ledgerIds: [] }),
  };
  const authService = { authorityValidator: jest.fn().mockResolvedValue(undefined) };
  const featureFlag = { isReviewResolutionEnabled: enabled };
  const controller = new ReviewResolutionController(
    resolutionService as never,
    authService as never,
    featureFlag as never,
  );
  return { controller, resolutionService, authService };
}

describe('ReviewResolutionController', () => {
  it('fails closed before authorization and service invocation', async () => {
    const { controller, resolutionService, authService } = build(false);

    await expect(
      controller.propose(user, {
        ledgerId: 1,
        reviewCode: 'COVERAGE_GAP',
        resolutionMode: 'DISCARD',
        evidenceRef: 'ticket-1',
        requestKey: 'request-1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(authService.authorityValidator).not.toHaveBeenCalled();
    expect(resolutionService.propose).not.toHaveBeenCalled();
  });

  it('checks SETTLE_PARTNER_CONFIRM and delegates propose with actor id', async () => {
    const { controller, resolutionService, authService } = build();
    const body = {
      ledgerId: 1,
      reviewCode: 'COVERAGE_GAP' as const,
      resolutionMode: 'DISCARD' as const,
      evidenceRef: 'ticket-1',
      requestKey: 'request-1',
    };

    await controller.propose(user, body);

    expect(authService.authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    expect(resolutionService.propose).toHaveBeenCalledWith(body, 42);
  });

  it('delegates approve and reject with actor id', async () => {
    const { controller, resolutionService } = build();

    await controller.approve(user, 7, { decisionReason: 'approved' });
    await controller.reject(user, 8, { reason: 'rejected' });

    expect(resolutionService.approve).toHaveBeenCalledWith(7, 42, 'approved');
    expect(resolutionService.reject).toHaveBeenCalledWith(8, 42, 'rejected');
  });
  it('declares proposal-id decision routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ReviewResolutionController.prototype.approve)).toBe(
      ':proposalId/approve',
    );
    expect(Reflect.getMetadata(PATH_METADATA, ReviewResolutionController.prototype.reject)).toBe(':proposalId/reject');
  });
});
