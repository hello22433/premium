import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import {
  OrderDeliveryRefundEntity,
  OrderDeliveryRefundRestoreType,
  OrderDeliveryRefundSourcePath,
} from '../../entity/order.delivery.refund.entity';

export interface ClaimRefundInput {
  orderDeliveryId: number;
  userId: number;
  refundAmount: number;
  restoreType: OrderDeliveryRefundRestoreType;
  isSettleComplete: boolean;
  isSettleBalance: boolean;
  sourcePath: OrderDeliveryRefundSourcePath;
  operatorUserId?: number | null;
  memo?: string | null;
  /**
   * SSG 잔액 보정이 아직 안 끝났음을 표시. SSG 주문은 claim 시점에 true 로 줘서
   * `ssg_balance_settled=false` 로 INSERT 한다. resolver 가 RESTORED/SKIPPED_CONFIRMED 반환 시
   * `markSsgSettled()` 호출로 true 로 갱신. 비-SSG 주문이면 생략(기본 false → settled=true default).
   * plans/ssg-balance-refactor.md PR3 보강.
   */
  ssgPending?: boolean;
}

/**
 * 환불 멱등성 락 서비스.
 *
 * order_delivery_refund 테이블의 UNIQUE 제약을 이용해 동일 발송건에 대한
 * 중복 환불을 구조적으로 차단한다. PIN 발급 dedup 테이블과 동일 패턴.
 *
 * - claim(): 환불 실행 직전 호출. 중복이면 BadRequestException throw + 호출자 환불 스킵.
 * - release(): 재발송 성공 시 호출. row DELETE → 재실패 시 다시 환불 가능.
 * - {claim,release}WithManager(): 명시적 queryRunner 트랜잭션 사용 path 용.
 */
@Injectable()
export class RefundLedgerService {
  private readonly logger = new Logger(RefundLedgerService.name);

  constructor(
    @InjectRepository(OrderDeliveryRefundEntity)
    private readonly refundRepository: Repository<OrderDeliveryRefundEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private readonly deliveryRepository: Repository<OrderDeliveryEntity>,
  ) {}

  async claim(input: ClaimRefundInput): Promise<void> {
    await this.insertLedger(this.refundRepository, input);
    await this.markRefundedAt(this.deliveryRepository, input.orderDeliveryId);
  }

  async release(orderDeliveryId: number): Promise<void> {
    await this.deleteLedger(this.refundRepository, orderDeliveryId);
    await this.clearRefundedAt(this.deliveryRepository, orderDeliveryId);
  }

  /**
   * 환불 ledger row 존재 여부 확인.
   * order_delivery.refunded_at은 다른 save/update 흐름에서 NULL로 덮어쓰일 수 있어
   * 환불 발생 판정의 신뢰 가능한 단일 소스로 사용한다.
   */
  async exists(orderDeliveryId: number): Promise<boolean> {
    const count = await this.refundRepository.count({ where: { orderDeliveryId } });
    return count > 0;
  }

  /**
   * SSG 행사 잔액 보정 완료 여부 확인. ledger row 가 없으면 false 반환.
   * 재발송 가드에서 `exists() AND isSsgSettled()` 둘 다 통과해야 새 선차감 진행.
   * plans/ssg-balance-refactor.md PR3 보강.
   */
  async isSsgSettled(orderDeliveryId: number): Promise<boolean> {
    const row = await this.refundRepository.findOne({
      where: { orderDeliveryId },
      select: ['ssgBalanceSettled'],
    });
    return row?.ssgBalanceSettled ?? false;
  }

  /**
   * SSG resolver 가 RESTORED 또는 SKIPPED_CONFIRMED 반환 시 호출.
   * ledger row 의 `ssg_balance_settled` 를 true 로 갱신한다.
   * row 가 없으면 silently skip (정상 흐름이라면 claim 이 먼저 일어났어야 함).
   * plans/ssg-balance-refactor.md PR3 보강.
   *
   * @param recoverToken 전달 시 token-fenced: 본인 소유 lease(ssg_recover_token 일치) row 만 마킹.
   *   lease 만료/탈취된 stale holder 가 settled 를 마킹하는 것을 차단한다. 미전달 시 unconditional(동기 호출).
   */
  async markSsgSettled(orderDeliveryId: number, recoverToken?: string): Promise<void> {
    const qb = this.refundRepository
      .createQueryBuilder()
      .update(OrderDeliveryRefundEntity)
      .set({ ssgBalanceSettled: true })
      .where('order_delivery_id = :id', { id: orderDeliveryId });
    if (recoverToken != null) {
      qb.andWhere('ssg_recover_token = :tok', { tok: recoverToken });
    }
    const result = await qb.execute();
    if (!result.affected) {
      const fenceNote = recoverToken != null ? ' (token-fenced — lease 만료/탈취 가능성)' : '';
      this.logger.warn(`markSsgSettled: 대상 row 없음 (skip). orderDeliveryId=${orderDeliveryId}${fenceNote}`);
    }
  }

  async claimWithManager(manager: EntityManager, input: ClaimRefundInput): Promise<void> {
    await this.insertLedger(manager.getRepository(OrderDeliveryRefundEntity), input);
    await this.markRefundedAt(manager.getRepository(OrderDeliveryEntity), input.orderDeliveryId);
  }

  async releaseWithManager(manager: EntityManager, orderDeliveryId: number): Promise<void> {
    await this.deleteLedger(manager.getRepository(OrderDeliveryRefundEntity), orderDeliveryId);
    await this.clearRefundedAt(manager.getRepository(OrderDeliveryEntity), orderDeliveryId);
  }

  private async insertLedger(
    repo: Repository<OrderDeliveryRefundEntity>,
    input: ClaimRefundInput,
  ): Promise<void> {
    try {
      await repo
        .createQueryBuilder()
        .insert()
        .into(OrderDeliveryRefundEntity)
        .values({
          orderDeliveryId: input.orderDeliveryId,
          userId: input.userId,
          refundAmount: input.refundAmount,
          restoreType: input.restoreType,
          isSettleComplete: input.isSettleComplete,
          isSettleBalance: input.isSettleBalance,
          sourcePath: input.sourcePath,
          operatorUserId: input.operatorUserId ?? null,
          memo: input.memo ?? null,
          // SSG 주문은 보정 완료 신호 false 로 시작 → resolver 성공 시 markSsgSettled 로 true.
          // 그 외 (비-SSG) 는 true (의미 없음, 가드에서 SSG type 분기로 영향 X).
          ssgBalanceSettled: !input.ssgPending,
        })
        .execute();
    } catch (e: any) {
      if (e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062) {
        this.logger.warn(
          `환불 중복 차단: orderDeliveryId=${input.orderDeliveryId}, sourcePath=${input.sourcePath}`,
        );
        throw new BadRequestException(
          `이미 환불된 발송건입니다. (orderDeliveryId: ${input.orderDeliveryId})`,
        );
      }
      throw e;
    }
  }

  private async deleteLedger(
    repo: Repository<OrderDeliveryRefundEntity>,
    orderDeliveryId: number,
  ): Promise<void> {
    const result = await repo.delete({ orderDeliveryId });
    if (!result.affected) {
      this.logger.warn(`환불 해제 중복 차단: orderDeliveryId=${orderDeliveryId} (ledger row 없음)`);
      throw new BadRequestException(
        `이미 해제된 환불 ledger입니다. (orderDeliveryId: ${orderDeliveryId})`,
      );
    }
  }

  private async markRefundedAt(
    repo: Repository<OrderDeliveryEntity>,
    orderDeliveryId: number,
  ): Promise<void> {
    await repo
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ refundedAt: () => 'CURRENT_TIMESTAMP(6)' })
      .where('id = :id', { id: orderDeliveryId })
      .execute();
  }

  private async clearRefundedAt(
    repo: Repository<OrderDeliveryEntity>,
    orderDeliveryId: number,
  ): Promise<void> {
    await repo.update({ id: orderDeliveryId }, { refundedAt: null });
  }
}
