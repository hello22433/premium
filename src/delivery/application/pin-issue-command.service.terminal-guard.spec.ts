import { PinIssueCommandService } from './pin-issue-command.service';
import {
  PIN_ISSUE_AUTOMATED_TRANSITION_STATUSES,
  PinIssueCommandStatus,
  SsgPinResolution,
} from '../interface/pin.issue.command.status';

/**
 * MEDIUM(재리뷰) — 종결된(SUCCEEDED/TERMINAL/EXHAUSTED) 명령을 후속 오류가 같은 권한으로
 * 다시 UNKNOWN/TERMINAL 로 덮지 못하도록, 판정 전이 CAS 에 이전-상태 가드가 포함돼야 한다.
 */
describe('PinIssueCommandService terminal-status CAS guard', () => {
  const authority = { commandId: '1', ownerToken: 'o', generation: '0', workflowVersion: '0' };

  const buildQb = () => {
    const qb: any = {
      update: jest.fn(() => qb),
      set: jest.fn(() => qb),
      where: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    return qb;
  };
  const guardCall = (qb: any) =>
    qb.andWhere.mock.calls.find((call: any[]) => call[0] === 'status IN (:...allowedStatuses)');

  it('recordResolution refuses to overwrite a terminal command', async () => {
    const qb = buildQb();
    const service = new PinIssueCommandService({ createQueryBuilder: jest.fn(() => qb) } as any);

    await service.recordResolution(authority, {
      resolution: SsgPinResolution.UNKNOWN,
      status: PinIssueCommandStatus.TERMINAL,
    });

    expect(guardCall(qb)).toBeDefined();
    expect(guardCall(qb)[1]).toEqual({ allowedStatuses: PIN_ISSUE_AUTOMATED_TRANSITION_STATUSES });
  });

  it('markSucceeded (transitionOwned) carries the terminal guard', async () => {
    const qb = buildQb();
    const service = new PinIssueCommandService({ createQueryBuilder: jest.fn(() => qb) } as any);

    await service.markSucceeded(authority);

    expect(guardCall(qb)).toBeDefined();
  });

  it('markSucceededAfterDeliveryClaimRelease carries the same previous-status guard', async () => {
    const qb = buildQb();
    const manager = {
      createQueryBuilder: jest.fn(() => qb),
    };
    const repository = {
      manager: {
        transaction: jest.fn(async (callback: (value: typeof manager) => Promise<boolean>) => callback(manager)),
      },
    };
    const service = new PinIssueCommandService(repository as any);

    await service.markSucceededAfterDeliveryClaimRelease(authority, 1, '2026-08-11T00:00:00.000Z');

    expect(guardCall(qb)).toBeDefined();
  });

  it('markOpsReviewRequired carries the terminal guard', async () => {
    const qb = buildQb();
    const service = new PinIssueCommandService({ createQueryBuilder: jest.fn(() => qb) } as any);

    await service.markOpsReviewRequired(authority, SsgPinResolution.UNKNOWN);

    expect(guardCall(qb)).toBeDefined();
  });

  it('allows automated transitions only from worker-owned in-progress statuses', () => {
    expect(PIN_ISSUE_AUTOMATED_TRANSITION_STATUSES).toEqual([
      PinIssueCommandStatus.STARTED,
      PinIssueCommandStatus.RETRY_PENDING,
      PinIssueCommandStatus.RETRYING,
    ]);
  });
});
