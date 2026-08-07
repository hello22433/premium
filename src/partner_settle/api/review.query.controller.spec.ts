import { NotFoundException } from '@nestjs/common';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { ReviewQueryController } from './review.query.controller';

const user = { id: 42 } as never;
function build(enabled = true) {
  const reviewQueryService = {
    findNeedsReview: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    findManualLedgerProposals: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    findOrphanInbox: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };
  const authService = { authorityValidator: jest.fn().mockResolvedValue(undefined) };
  const controller = new ReviewQueryController(
    reviewQueryService as never,
    authService as never,
    { isReviewResolutionEnabled: enabled } as never,
  );
  return { controller, reviewQueryService, authService };
}

describe('ReviewQueryController', () => {
  it('fails closed before authorization when review APIs are disabled', async () => {
    const { controller, authService, reviewQueryService } = build(false);
    await expect(controller.needsReview(user, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(authService.authorityValidator).not.toHaveBeenCalled();
    expect(reviewQueryService.findNeedsReview).not.toHaveBeenCalled();
  });

  it('authorizes all GET contracts and delegates their filters unchanged', async () => {
    const { controller, authService, reviewQueryService } = build();
    const needsReview = { source: 'ORPHAN_EVENT' as const, limit: 10 };
    const proposals = { status: 'REJECTED' as const, orderDeliveryId: 8 };
    const orphanInbox = { partnerCompanyId: 7, cursor: 'cursor' };

    await controller.needsReview(user, needsReview);
    await controller.manualLedgerProposals(user, proposals);
    await controller.orphanInbox(user, orphanInbox);

    expect(authService.authorityValidator).toHaveBeenCalledWith(user, UserAuthSubEnum.SETTLE_PARTNER_CONFIRM);
    expect(reviewQueryService.findNeedsReview).toHaveBeenCalledWith(needsReview);
    expect(reviewQueryService.findManualLedgerProposals).toHaveBeenCalledWith(proposals);
    expect(reviewQueryService.findOrphanInbox).toHaveBeenCalledWith(orphanInbox);
  });
});
