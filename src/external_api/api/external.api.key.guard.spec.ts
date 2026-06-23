import { createHash } from 'crypto';
import { ApiKeyGuard } from './external.api.key.guard';
import { ExternalApiException } from './external.api.exception.filter';
import { IUserStatus } from '../../user/interface/user.status';

/**
 * PR2 Phase 6 (HIGH-4) — guard 가 레거시 account 를 apiKeyHash 가 아닌
 * apiApp.sourceAccountId(결정적 매핑)로 로드한다. 신규 credential 단독 발급(새 hash)
 * 시에도 account 조회가 깨지지 않아 다중키/회전이 동작한다.
 */
describe('ApiKeyGuard (PR2 Phase 6 HIGH-4 account 로드 전환)', () => {
  const makeContext = (apiKey: string, ip = '1.2.3.4') => ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: { 'x-api-key': apiKey }, ip }),
    }),
  });

  const makeGuard = (over: { credential?: unknown; account?: unknown }) => {
    const credentialRepository = { findOne: jest.fn(async () => over.credential ?? null) };
    const accountRepository = { findOne: jest.fn(async () => over.account ?? null) };
    const accountStatusTransitionService = { touchLastActivity: jest.fn(async () => undefined) };
    const guard = new ApiKeyGuard(
      accountRepository as any,
      credentialRepository as any,
      accountStatusTransitionService as any,
    );
    return { guard, credentialRepository, accountRepository, accountStatusTransitionService };
  };

  const apiApp = (over?: Record<string, unknown>) => ({
    id: '10',
    isActive: true,
    sourceAccountId: '500',
    defaultBillingUserId: 42,
    allowedIps: [{ ipAddress: '1.2.3.4' }],
    ...over,
  });
  const account = () => ({
    id: '500',
    user: { id: 42, status: IUserStatus.USED, company: undefined, lastActivityAt: null },
    allowedIps: [],
  });

  it('신규 credential(새 hash) → account 를 sourceAccountId 로 로드(hash 무관) → 인증 통과', async () => {
    const newKey = 'brand-new-rotated-key';
    const newHash = createHash('sha256').update(newKey).digest('hex');
    const { guard, accountRepository, credentialRepository } = makeGuard({
      credential: { apiApp: apiApp(), apiKeyHash: newHash, isActive: true },
      account: account(),
    });

    const ok = await guard.canActivate(makeContext(newKey) as any);

    expect(ok).toBe(true);
    // credential 은 새 hash 로 조회
    expect(credentialRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ apiKeyHash: newHash, isActive: true }) }),
    );
    // account 는 hash 가 아닌 sourceAccountId(id) 로 조회 (HIGH-4 핵심)
    expect(accountRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: '500', isActive: true } }),
    );
    const accountWhere = (accountRepository.findOne.mock.calls[0] as any[])[0].where;
    expect(accountWhere.apiKeyHash).toBeUndefined();
  });

  it('sourceAccountId null(순수 PR2 app) → defaultBillingUserId 로 account 폴백 조회', async () => {
    const key = 'k';
    const hash = createHash('sha256').update(key).digest('hex');
    const { guard, accountRepository } = makeGuard({
      credential: { apiApp: apiApp({ sourceAccountId: null }), apiKeyHash: hash, isActive: true },
      account: account(),
    });

    await guard.canActivate(makeContext(key) as any);

    expect(accountRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 42, isActive: true } }),
    );
  });

  it('비활성 credential/app → 1001', async () => {
    const { guard } = makeGuard({ credential: null });
    await expect(guard.canActivate(makeContext('x') as any)).rejects.toMatchObject({ code: '1001' });
  });

  it('account.user 상태 LEAVE → 1001 (휴면/탈퇴 차단 유지)', async () => {
    const key = 'k';
    const hash = createHash('sha256').update(key).digest('hex');
    const acc = account();
    (acc.user as any).status = IUserStatus.LEAVE;
    const { guard } = makeGuard({
      credential: { apiApp: apiApp(), apiKeyHash: hash, isActive: true },
      account: acc,
    });
    await expect(guard.canActivate(makeContext(key) as any)).rejects.toBeInstanceOf(ExternalApiException);
  });

  it('불변식 위반(account.user.id ≠ defaultBillingUserId) → 1001 fail-closed', async () => {
    const key = 'k';
    const hash = createHash('sha256').update(key).digest('hex');
    const acc = account();
    (acc.user as any).id = 999; // defaultBillingUserId(42)와 불일치
    const { guard } = makeGuard({
      credential: { apiApp: apiApp(), apiKeyHash: hash, isActive: true },
      account: acc,
    });
    await expect(guard.canActivate(makeContext(key) as any)).rejects.toMatchObject({ code: '1001' });
  });

  it('IP 불일치 → 1004', async () => {
    const key = 'k';
    const hash = createHash('sha256').update(key).digest('hex');
    const { guard } = makeGuard({
      credential: { apiApp: apiApp({ allowedIps: [{ ipAddress: '9.9.9.9' }] }), apiKeyHash: hash, isActive: true },
      account: account(),
    });
    await expect(guard.canActivate(makeContext(key, '1.2.3.4') as any)).rejects.toMatchObject({ code: '1004' });
  });
});
