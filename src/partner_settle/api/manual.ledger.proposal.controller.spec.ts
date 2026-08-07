import { ManualLedgerProposalController } from './manual.ledger.proposal.controller';

describe('ManualLedgerProposalController', () => {
  const user = { id: 10 } as any;
  const service = { propose: jest.fn(), approve: jest.fn(), reject: jest.fn() };
  const auth = { authorityValidator: jest.fn() };
  const flag = { isReviewResolutionEnabled: true };
  beforeEach(() => jest.clearAllMocks());
  it('delegates propose with the authenticated actor', async () => {
    service.propose.mockResolvedValue({ proposal: { id: 1 }, ledgerIds: [] });
    const controller = new ManualLedgerProposalController(service as any, auth as any, flag as any);
    await expect(controller.propose(user, { provider: 'GALAXIA', inboxRowId: 1 } as any)).resolves.toEqual({
      proposal: { id: 1 },
      ledgerIds: [],
    });
    expect(service.propose).toHaveBeenCalledWith(expect.anything(), 10);
  });
  it('delegates independent approve and reject decisions', async () => {
    const controller = new ManualLedgerProposalController(service as any, auth as any, flag as any);
    await controller.approve(user, 1, { decisionReason: 'approved' });
    await controller.reject(user, 1, { reason: 'rejected' });
    expect(service.approve).toHaveBeenCalledWith(1, 10, 'approved');
    expect(service.reject).toHaveBeenCalledWith(1, 10, 'rejected');
    expect(Reflect.getMetadata('path', ManualLedgerProposalController.prototype.approve)).toBe(':proposalId/approve');
    expect(Reflect.getMetadata('path', ManualLedgerProposalController.prototype.reject)).toBe(':proposalId/reject');
  });
});
