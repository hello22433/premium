import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';

import { OrderEntity } from '../../entity/order.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { DeliverySendHistoryEntity } from '../../entity/delivery.send.history.entity';
import { IOrderType } from '../../order/interface/order.type';
import { IOrderStatus } from '../../order/interface/order.status';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';

/**
 * 복구 후보 1건: stuck 외부주문의 발송 성공 delivery.
 */
interface StuckDeliveryRow {
  orderId: number;
  deliveryId: number;
  sentAt: string | Date | null;
}

/**
 * 외부 API 주문 완료전이 drift 복구.
 *
 * ExternalApiService.createOrder / createSsgOrder 는 비원자 3-phase 다:
 *   A(주문/차감, tx) → B(쿠폰발급+발송, tx 없음) → C(order=DELIVERY_COMPLETE, tx).
 * B(발송) 성공 후 C 커밋 전에 프로세스가 죽으면 쿠폰·문자는 이미 나갔는데 order 는
 * DELIVERY_REQUEST 로 영구 stuck 된다. 발송 배치 claim 은 EXTERNAL 을 제외하고,
 * reconcileSettlementDrift 는 DELIVERY_CONFIRMED 만 보므로 어떤 스윕도 이 케이스를 수렴시키지 못했다.
 *
 * 완료 신호(오완료 방지): 해당 order_delivery 에 연결된 발송 성공 이력
 *   (delivery_send_history.order_delivery_id = od.id AND is_success = 1) 이 존재할 때만 완료 전이한다.
 * 발송 실패는 is_success=false 이력이 남으므로, "쿠폰만 발급되고 미발송/미발급" 케이스는
 * 자동완료 대상에서 안전하게 제외된다(그 케이스는 CS 수동 처리/환불 경로).
 *
 * 정산은 여기서 건드리지 않는다 — phaseC_handleSuccess 와 동일(완료 전이만). order 가
 * DELIVERY_COMPLETE 가 되면 기존 reconcileSettlementDrift(part 2)가 PRE_PAYMENT 선정산을 수렴시킨다.
 */
@Injectable()
export class ExternalOrderRecoveryService {
  private readonly logger = new Logger(ExternalOrderRecoveryService.name);

  /** 한 회 sweep 처리 후보 상한. */
  static readonly SWEEP_LIMIT = 200;
  /** 진행 중인 정상 요청 오복구 방지 grace(ms). 동기 dispatch 는 수 초면 끝나므로 기본 5분이면 충분. */
  private static readonly DEFAULT_GRACE_MS = 5 * 60 * 1000;

  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private readonly orderDeliveryRepository: Repository<OrderDeliveryEntity>,
  ) {}

  private resolveGraceMs(): number {
    const raw = process.env.EXTERNAL_ORDER_RECOVERY_GRACE_MS?.trim();
    if (!raw) return ExternalOrderRecoveryService.DEFAULT_GRACE_MS;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : ExternalOrderRecoveryService.DEFAULT_GRACE_MS;
  }

  /**
   * grace 경과 + 발송 성공 이력이 있는 stuck 외부주문을 완료 전이한다.
   * @returns 후보/복구/skip 통계.
   */
  async recoverStuckOrders(): Promise<{ candidates: number; recovered: number; skipped: number }> {
    const cutoff = new Date(Date.now() - this.resolveGraceMs());
    const rows = await this.findStuckDeliveries(cutoff);

    let recovered = 0;
    let skipped = 0;
    for (const row of rows) {
      try {
        if (await this.completeStuckOrder(row)) {
          recovered++;
        } else {
          skipped++;
        }
      } catch (e) {
        skipped++;
        this.logger.error(
          `[EXT_RECOVERY] 복구 실패 orderId=${row.orderId}, deliveryId=${row.deliveryId}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    if (rows.length > 0) {
      this.logger.log(`[EXT_RECOVERY] candidates=${rows.length}, recovered=${recovered}, skipped=${skipped}`);
    }
    return { candidates: rows.length, recovered, skipped };
  }

  private async findStuckDeliveries(cutoff: Date): Promise<StuckDeliveryRow[]> {
    return this.orderDeliveryRepository
      .createQueryBuilder('od')
      .innerJoin('od.orderProductMapping', 'opm')
      .innerJoin('opm.order', 'o')
      .innerJoin(DeliverySendHistoryEntity, 'dsh', 'dsh.orderDeliveryId = od.id AND dsh.isSuccess = 1')
      .select('o.id', 'orderId')
      .addSelect('od.id', 'deliveryId')
      .addSelect('MIN(dsh.createdAt)', 'sentAt')
      .where('o.type IN (:...types)', { types: [IOrderType.EXTERNAL, IOrderType.SSG] })
      .andWhere('o.status = :req', { req: IOrderStatus.DELIVERY_REQUEST })
      .andWhere('o.registerAt < :cutoff', { cutoff })
      .andWhere('od.status = :wait', { wait: IOrderDeliveryStatus.WAIT })
      .andWhere('od.barCode IS NOT NULL')
      .groupBy('od.id')
      .addGroupBy('o.id')
      .limit(ExternalOrderRecoveryService.SWEEP_LIMIT)
      .getRawMany<StuckDeliveryRow>();
  }

  /**
   * phaseC_handleSuccess 미러(멱등 CAS): delivery WAIT→COMPLETE + actualSendAt 백필,
   * order DELIVERY_REQUEST→DELIVERY_COMPLETE. CAS 라 취소/이중 전이 자연 차단.
   */
  @Transactional()
  private async completeStuckOrder(row: StuckDeliveryRow): Promise<boolean> {
    const sentAt = row.sentAt ? new Date(row.sentAt) : new Date();

    await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ status: IOrderDeliveryStatus.COMPLETE, actualSendAt: sentAt })
      .where('id = :id', { id: row.deliveryId })
      .andWhere('status = :wait', { wait: IOrderDeliveryStatus.WAIT })
      .execute();

    const res = await this.orderRepository
      .createQueryBuilder()
      .update(OrderEntity)
      .set({ status: IOrderStatus.DELIVERY_COMPLETE })
      .where('id = :id', { id: row.orderId })
      .andWhere('status = :req', { req: IOrderStatus.DELIVERY_REQUEST })
      .execute();

    const transitioned = (res.affected ?? 0) > 0;
    if (transitioned) {
      this.logger.warn(
        `[EXT_RECOVERY] stuck 외부주문 완료 전이 orderId=${row.orderId}, deliveryId=${row.deliveryId} ` +
          `(발송 성공 이력 확인 → Phase C 크래시 복구)`,
      );
    }
    return transitioned;
  }
}
