import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { OrderEntity } from '../../entity/order.entity';
import { PointGrantEntity } from '../../entity/point.grant.entity';
import { calculateSettlementPrice } from '../../util/settle-fee.util';
import { PointPolicyEffect } from '../interface/point-policy-scope';
import { PointPolicyService } from './point-policy.service';
import { AllocationInput, AllocationInputGrant, AllocationLineInput } from './payment-allocation.service';

/**
 * order → AllocationInput 변환 (Wallet Cutover Bundle).
 *
 * OrderService private 에서 추출한 shared builder. external API 도 동일 경로로 재사용한다.
 * 동작 변경 없음 — OrderService.buildWalletAllocationInput 본문 그대로.
 *
 * - 라인 단위 gross: `calculateSettlementPrice(mapping, false, delivery)`
 * - 카드할증: 주문 단위 1회 적용 (PaymentAllocationService 내부) → false 로 계산
 * - pointPolicyEffect: PointPolicyService.evaluate 로 라인별 ALLOW/DENY 평가
 * - 예치금: 선정산 = 자동 전액, 후정산 = depositUseEnabled 토글 기준
 * - grants: requestedPointAmount > 0 일 때만 DB 조회
 */
@Injectable()
export class WalletAllocationInputBuilder {
  constructor(
    private readonly pointPolicyService: PointPolicyService,
    @InjectRepository(PointGrantEntity)
    private readonly pointGrantRepository: Repository<PointGrantEntity>,
  ) {}

  async build(
    order: OrderEntity,
    wallet: {
      id: string;
      depositBalance: number;
      creditLimit: number;
      creditUsedAmount: number;
      settleCondition: 'PRE_PAYMENT' | 'POST_PAYMENT';
    },
    finalAmount: number,
    opts: {
      requestedPointAmount?: number;
      depositUseEnabled?: boolean;
      depositUseAmount?: number;
      companyId: number | null;
    },
  ): Promise<AllocationInput> {
    void finalAmount; // allocate() 가 라인 합으로 다시 계산 — 호출자가 일관성 검증용으로만 사용
    const isPrePayment = wallet.settleCondition === 'PRE_PAYMENT';

    // 라인별 포인트 정책(ALLOW/DENY) 평가. 같은 매핑은 scope 동일 → 매핑 단위 캐시로 중복 쿼리 방지.
    const effectByMapping = new Map<number, PointPolicyEffect>();
    const lines: AllocationLineInput[] = [];
    for (const mapping of order.orderProductMappings ?? []) {
      let effect = effectByMapping.get(mapping.id);
      if (effect === undefined) {
        effect = await this.pointPolicyService.evaluate({
          companyId: opts.companyId,
          scope: {
            productId: mapping.productId,
            brandId: mapping.product?.brandId ?? null,
            brandName: mapping.product?.brand?.nameKorean ?? null,
            category: mapping.product?.category ?? null,
            partnerCompanyCode: mapping.product?.partnerCompany?.code ?? null,
            orderType: order.type as unknown as string,
          },
        });
        effectByMapping.set(mapping.id, effect);
      }
      for (const delivery of mapping.orderDeliveries) {
        lines.push({
          orderProductMappingId: mapping.id,
          orderDeliveryId: delivery.id,
          productId: mapping.productId,
          brandId: mapping.product?.brandId ?? null,
          category: mapping.product?.category ?? null,
          partnerCompanyId: mapping.product?.partnerCompanyId ?? null,
          orderType: order.type as unknown as string,
          grossSettlementAmount: calculateSettlementPrice(mapping, false, delivery),
          appliedFeePercent: mapping.fee,
          appliedPriceAdjustment: mapping.priceAdjustment as 'DISCOUNT' | 'ADDITIONAL' | null,
          pointPolicyEffect: effect === PointPolicyEffect.DENY ? 'DENY' : 'ALLOW',
        });
      }
    }

    const requestedPointAmount = opts.requestedPointAmount ?? 0;

    // 예치금: 선정산 = 자동 전액(입력 무시), 후정산 = 토글 ON 일 때만 (금액 미지정 시 잔액 한도까지).
    let requestedDepositAmount: number | null;
    if (isPrePayment) {
      requestedDepositAmount = null; // allocate() 가 availableDeposit 까지 자동 사용
    } else if (opts.depositUseEnabled) {
      requestedDepositAmount = opts.depositUseAmount ?? wallet.depositBalance;
    } else {
      requestedDepositAmount = 0;
    }

    return {
      orderId: order.id,
      walletAccountId: wallet.id,
      lines,
      cardSurchargeApplied: order.cardSurchargeApplied,
      requestedPointAmount,
      requestedDepositAmount,
      availableDeposit: wallet.depositBalance,
      creditLimit: wallet.creditLimit,
      creditUsedAmountBefore: wallet.creditUsedAmount,
      isPrePayment,
      grants: requestedPointAmount > 0 ? await this.loadPointGrants(wallet.id) : [],
    };
  }

  /** 포인트 사용 가능 grant 목록 (active + 잔여>0). allocate() 가 만료임박순 + FIFO 로 소비. */
  private async loadPointGrants(walletAccountId: string): Promise<AllocationInputGrant[]> {
    const grants = await this.pointGrantRepository.find({
      where: { walletAccountId, active: 1, remainingAmount: MoreThan(0) },
    });
    return grants.map((g) => ({
      pointGrantId: g.id,
      remainingAmount: g.remainingAmount,
      expiresAt: g.expiresAt,
    }));
  }
}
