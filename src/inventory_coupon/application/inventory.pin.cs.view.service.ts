import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InventoryPinItemEntity } from '../../entity/inventory.pin.item.entity';
import { InventoryPinEmailAttemptEntity } from '../../entity/inventory.pin.email.attempt.entity';
import { InventoryPinBillingChainEntity } from '../../entity/inventory.pin.billing.chain.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderDeliveryRefundEntity } from '../../entity/order.delivery.refund.entity';
import { InventoryPinPolicyService } from './inventory.pin.policy.service';
import {
  DirectPinFulfillmentStatus,
  InventoryPinBillingChainState,
} from '../domain/inventory.pin.status';

export type InventoryPinCsAllowedAction =
  | 'RESEND_SAME_PIN'
  | 'CHANGE_TARGET_BEFORE_SEND'
  | 'TERMINAL_CANCEL_REFUND'
  | 'VOID_AND_REISSUE';

export type InventoryPinCsLatestAttemptStatus = 'NONE' | 'CLAIMED' | 'SENT' | 'FAILED' | 'UNKNOWN';

/**
 * 재고형 PIN CS 화면 계약 (rev5 §4.1).
 * deliveryContentMode 가 있으면 재고형, 없으면(뷰 자체가 null) 일반 쿠폰이다.
 */
export interface InventoryPinCsView {
  deliveryContentMode: 'DIRECT_PIN';
  primaryPinMasked: string;
  secondaryPinMasked: string | null;
  pinInventoryStatus: 'ASSIGNED' | 'VOID';
  fulfillmentStatus: DirectPinFulfillmentStatus;
  latestAttemptStatus: InventoryPinCsLatestAttemptStatus;
  paymentState: InventoryPinBillingChainState;
  isCurrentPaymentOwner: boolean;
  canRevealPin: boolean;
  canRevealHistoricalPin: boolean;
  allowedActions: InventoryPinCsAllowedAction[];
}

/**
 * CS 상세에서 "이 건에 어떤 처리가 허용되는가"를 서버가 판정해 내려주는 읽기 전용 서비스.
 *
 * 판정 기준은 InventoryPinCsService 의 각 액션이 실제로 검사하는 조건과 동일하게 둔다.
 * 프론트가 상태 조합으로 유추하면 할 수 없는 처리를 열거나 해야 하는 처리를 막게 되므로,
 * 버튼 노출 근거는 이 한 곳에서만 만든다.
 */
@Injectable()
export class InventoryPinCsViewService {
  constructor(
    @InjectRepository(InventoryPinItemEntity)
    private readonly itemRepo: Repository<InventoryPinItemEntity>,
    @InjectRepository(InventoryPinBillingChainEntity)
    private readonly chainRepo: Repository<InventoryPinBillingChainEntity>,
    @InjectRepository(InventoryPinEmailAttemptEntity)
    private readonly attemptRepo: Repository<InventoryPinEmailAttemptEntity>,
    @InjectRepository(OrderDeliveryRefundEntity)
    private readonly refundRepo: Repository<OrderDeliveryRefundEntity>,
    private readonly policyService: InventoryPinPolicyService,
  ) {}

  /**
   * 재고형 발송건이 아니면 null. 호출부는 null 을 "일반 쿠폰"으로 처리한다.
   */
  async getView(delivery: OrderDeliveryEntity): Promise<InventoryPinCsView | null> {
    if (!delivery.inventoryPinBillingChainId && !delivery.directPinFulfillmentStatus) {
      return null;
    }

    const chain = delivery.inventoryPinBillingChainId
      ? await this.chainRepo.findOne({ where: { id: delivery.inventoryPinBillingChainId } })
      : null;
    if (!chain) {
      return null;
    }

    // PIN 원문은 절대 읽지 않는다 — 마스킹 컬럼과 상태만 본다.
    const item = await this.itemRepo.findOne({
      where: { assignedOrderDeliveryId: delivery.id },
      select: ['id', 'primaryCodeMasked', 'secondaryCodeMasked', 'status'],
    });

    const activeClaimed = await this.attemptRepo.findOne({
      where: { orderDeliveryId: delivery.id, status: 'CLAIMED' },
      select: ['id'],
    });
    const latestAttemptStatus = await this.resolveLatestAttemptStatus(delivery, !!activeClaimed);

    const existingRefund = await this.refundRepo.findOne({
      where: { orderDeliveryId: delivery.id },
      select: ['id'],
    });

    const fulfillmentStatus: DirectPinFulfillmentStatus = delivery.directPinFulfillmentStatus ?? 'UNKNOWN';
    const isCurrentPaymentOwner = Number(chain.currentOrderDeliveryId) === delivery.id;
    const isDebited = chain.state === 'DEBITED';
    const isVoided = fulfillmentStatus === 'VOID' || item?.status === 'VOID';
    const sendInProgress = !!activeClaimed;

    // revealPin 가드와 동일: 현재 결제 소유자 + DEBITED + item ASSIGNED + fulfillment 비-VOID
    const canRevealPin = isDebited && isCurrentPaymentOwner && item?.status === 'ASSIGNED' && !isVoided;

    // 이전 소유(폐기·환불) 건의 원문 재확인은 이를 허용하는 엔드포인트가 없다.
    // 지금 백엔드에서 열어주면 reveal 호출이 그대로 403 이 되므로 항상 false 로 내린다.
    const canRevealHistoricalPin = false;

    const allowedActions: InventoryPinCsAllowedAction[] = [];
    const ownerActionable = isDebited && isCurrentPaymentOwner && !sendInProgress;

    if (ownerActionable && !isVoided && !existingRefund) {
      allowedActions.push('RESEND_SAME_PIN');
    }
    // CHANGE_TARGET_BEFORE_SEND 는 아직 내려주지 않는다.
    // 재고형 수신정보 변경 엔드포인트가 없고 deliveryTargetVersion 을 증가시키는 writer 도 없다
    // (읽는 곳은 inventory.pin.send.service 뿐). 지금 노출하면 실행할 API 없는 버튼이 열린다.
    if (ownerActionable) {
      allowedActions.push('TERMINAL_CANCEL_REFUND');
    }
    if (ownerActionable && !isVoided) {
      // voidAndReissue 는 트랜잭션 안에서 allocationEnabled 를 다시 확인한다 (여기서는 표시용).
      const policy = await this.policyService.readPolicy();
      if (policy.allocationEnabled) {
        allowedActions.push('VOID_AND_REISSUE');
      }
    }

    return {
      deliveryContentMode: 'DIRECT_PIN',
      primaryPinMasked: item?.primaryCodeMasked ?? '',
      secondaryPinMasked: item?.secondaryCodeMasked ?? null,
      pinInventoryStatus: item?.status === 'ASSIGNED' ? 'ASSIGNED' : 'VOID',
      fulfillmentStatus,
      latestAttemptStatus,
      paymentState: chain.state,
      isCurrentPaymentOwner,
      canRevealPin,
      canRevealHistoricalPin,
      allowedActions,
    };
  }

  private async resolveLatestAttemptStatus(
    delivery: OrderDeliveryEntity,
    hasActiveClaimed: boolean,
  ): Promise<InventoryPinCsLatestAttemptStatus> {
    if (hasActiveClaimed) return 'CLAIMED';
    if (!delivery.directPinLatestAttemptId) return 'NONE';

    const latest = await this.attemptRepo.findOne({
      where: { id: delivery.directPinLatestAttemptId },
      select: ['id', 'status'],
    });
    return latest?.status ?? 'NONE';
  }
}
