import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PointPolicyRuleEntity } from '../../entity/point.policy.rule.entity';
import { PointPolicyEffect, PointPolicyOwnerType, PointPolicyScopeType } from '../interface/point-policy-scope';
import { PointPolicyService } from './point-policy.service';

const rule = (overrides: Partial<PointPolicyRuleEntity>): PointPolicyRuleEntity =>
  ({
    id: '0',
    active: 1,
    ownerType: PointPolicyOwnerType.COMMON,
    ownerId: null,
    effect: PointPolicyEffect.ALLOW,
    scopeType: PointPolicyScopeType.PARTNER_COMPANY,
    scopeId: null,
    scopeCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as PointPolicyRuleEntity;

describe('PointPolicyService — 4단계 우선순위 + DENY > ALLOW', () => {
  let sut: PointPolicyService;
  let repo: jest.Mocked<Repository<PointPolicyRuleEntity>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PointPolicyService,
        { provide: getRepositoryToken(PointPolicyRuleEntity), useValue: { find: jest.fn() } },
      ],
    }).compile();
    sut = module.get(PointPolicyService);
    repo = module.get(getRepositoryToken(PointPolicyRuleEntity));
  });

  it('기본값은 ALLOW (rule 없음)', async () => {
    repo.find.mockResolvedValue([]);
    await expect(sut.evaluate({ companyId: 1, scope: { partnerCompanyCode: 'SSG' } })).resolves.toBe(
      PointPolicyEffect.ALLOW,
    );
  });

  it('공통 DENY 가 기본 ALLOW 를 덮어쓴다', async () => {
    repo.find.mockResolvedValue([
      rule({ scopeType: PointPolicyScopeType.PARTNER_COMPANY, scopeCode: 'SSG', effect: PointPolicyEffect.DENY }),
    ]);
    await expect(sut.evaluate({ companyId: 1, scope: { partnerCompanyCode: 'SSG' } })).resolves.toBe(
      PointPolicyEffect.DENY,
    );
  });

  it('고객사 ALLOW 가 공통 DENY 를 덮어쓴다 (우선순위 1)', async () => {
    repo.find.mockResolvedValue([
      rule({ scopeType: PointPolicyScopeType.PARTNER_COMPANY, scopeCode: 'SSG', effect: PointPolicyEffect.DENY }),
      rule({
        ownerType: PointPolicyOwnerType.COMPANY,
        ownerId: '7',
        scopeType: PointPolicyScopeType.PARTNER_COMPANY,
        scopeCode: 'SSG',
        effect: PointPolicyEffect.ALLOW,
      }),
    ]);
    await expect(sut.evaluate({ companyId: 7, scope: { partnerCompanyCode: 'SSG' } })).resolves.toBe(
      PointPolicyEffect.ALLOW,
    );
  });

  it('같은 우선순위에서 DENY > ALLOW', async () => {
    repo.find.mockResolvedValue([
      rule({
        ownerType: PointPolicyOwnerType.COMPANY,
        ownerId: '7',
        scopeType: PointPolicyScopeType.PARTNER_COMPANY,
        scopeCode: 'SSG',
        effect: PointPolicyEffect.ALLOW,
      }),
      rule({
        ownerType: PointPolicyOwnerType.COMPANY,
        ownerId: '7',
        scopeType: PointPolicyScopeType.PARTNER_COMPANY,
        scopeCode: 'SSG',
        effect: PointPolicyEffect.DENY,
      }),
    ]);
    await expect(sut.evaluate({ companyId: 7, scope: { partnerCompanyCode: 'SSG' } })).resolves.toBe(
      PointPolicyEffect.DENY,
    );
  });

  it('포인트 grant 예외 가 공통 보다 우선', async () => {
    repo.find.mockResolvedValue([
      rule({ scopeType: PointPolicyScopeType.PARTNER_COMPANY, scopeCode: 'SSG', effect: PointPolicyEffect.DENY }),
      rule({
        ownerType: PointPolicyOwnerType.POINT_GRANT,
        ownerId: '42',
        scopeType: PointPolicyScopeType.PARTNER_COMPANY,
        scopeCode: 'SSG',
        effect: PointPolicyEffect.ALLOW,
      }),
    ]);
    await expect(
      sut.evaluate({ companyId: 1, pointGrantId: '42', scope: { partnerCompanyCode: 'SSG' } }),
    ).resolves.toBe(PointPolicyEffect.ALLOW);
  });
});
