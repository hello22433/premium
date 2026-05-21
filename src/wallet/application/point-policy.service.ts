import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PointPolicyRuleEntity } from '../../entity/point.policy.rule.entity';
import { PointPolicyEffect, PointPolicyOwnerType, PointPolicyScopeType } from '../interface/point-policy-scope';

export interface PointPolicyScopeInput {
  productId?: number | null;
  brandId?: number | null;
  category?: string | null;
  partnerCompanyCode?: string | null;
  orderType?: string | null;
}

export interface PointPolicyContext {
  companyId: number | null;
  pointGrantId?: string | null;
  scope: PointPolicyScopeInput;
}

/**
 * 포인트 사용 가능 정책 평가.
 * 우선순위 (위에서부터 첫 명시된 effect 채택):
 *   1. 고객사별 예외 (owner_type=COMPANY)
 *   2. 포인트 grant 예외 (owner_type=POINT_GRANT)
 *   3. 공통 규칙 (owner_type=COMMON)
 *   4. 시스템 기본값 ALLOW
 * 같은 우선순위 안에서는 DENY > ALLOW.
 */
@Injectable()
export class PointPolicyService {
  constructor(
    @InjectRepository(PointPolicyRuleEntity)
    private readonly ruleRepository: Repository<PointPolicyRuleEntity>,
  ) {}

  async evaluate(ctx: PointPolicyContext): Promise<PointPolicyEffect> {
    const rules = await this.ruleRepository.find({ where: { active: 1 } });
    const matched = rules.filter((r) => this.matchesScope(r, ctx.scope));

    const tiers: PointPolicyOwnerType[] = [
      PointPolicyOwnerType.COMPANY,
      PointPolicyOwnerType.POINT_GRANT,
      PointPolicyOwnerType.COMMON,
    ];

    for (const tier of tiers) {
      const tierRules = matched.filter((r) => r.ownerType === tier && this.matchesOwner(r, tier, ctx));
      if (tierRules.length === 0) continue;
      // DENY > ALLOW
      if (tierRules.some((r) => r.effect === PointPolicyEffect.DENY)) return PointPolicyEffect.DENY;
      if (tierRules.some((r) => r.effect === PointPolicyEffect.ALLOW)) return PointPolicyEffect.ALLOW;
    }

    return PointPolicyEffect.ALLOW;
  }

  private matchesOwner(rule: PointPolicyRuleEntity, tier: PointPolicyOwnerType, ctx: PointPolicyContext): boolean {
    if (tier === PointPolicyOwnerType.COMMON) return rule.ownerId === null;
    if (tier === PointPolicyOwnerType.COMPANY) return ctx.companyId != null && rule.ownerId === String(ctx.companyId);
    if (tier === PointPolicyOwnerType.POINT_GRANT) return ctx.pointGrantId != null && rule.ownerId === ctx.pointGrantId;
    return false;
  }

  private matchesScope(rule: PointPolicyRuleEntity, scope: PointPolicyScopeInput): boolean {
    switch (rule.scopeType) {
      case PointPolicyScopeType.PRODUCT:
        return scope.productId != null && rule.scopeId === String(scope.productId);
      case PointPolicyScopeType.BRAND:
        if (scope.brandId != null && rule.scopeId === String(scope.brandId)) return true;
        return rule.scopeCode != null && rule.scopeCode === (scope.partnerCompanyCode ?? null);
      case PointPolicyScopeType.CATEGORY:
        return scope.category != null && rule.scopeCode === scope.category;
      case PointPolicyScopeType.PARTNER_COMPANY:
        return scope.partnerCompanyCode != null && rule.scopeCode === scope.partnerCompanyCode;
      case PointPolicyScopeType.ORDER_TYPE:
        return scope.orderType != null && rule.scopeCode === scope.orderType;
      default:
        return false;
    }
  }
}
