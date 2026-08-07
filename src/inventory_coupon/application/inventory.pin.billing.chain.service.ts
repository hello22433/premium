import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryRunner, Repository } from 'typeorm';
import { InventoryPinBillingChainEntity } from '../../entity/inventory.pin.billing.chain.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { PIN_INVENTORY_ERROR } from '../domain/inventory.pin.error.codes';

/**
 * 결제 체인 서비스. rev5 §4.9 + plan T5.
 *
 * 기존 관리자/배치 배송건에 대해 정확히 하나의 wallet allocation을 식별하여
 * 불변 billing chain을 생성한다.
 */
@Injectable()
export class InventoryPinBillingChainService {
  private readonly logger = new Logger(InventoryPinBillingChainService.name);

  constructor(
    @InjectRepository(InventoryPinBillingChainEntity)
    private readonly chainRepo: Repository<InventoryPinBillingChainEntity>,
  ) {}

  /**
   * 기존 선결제 배송건의 billing chain 확보.
   * rev5 §plan T5: ensureForExistingPrepaidDelivery().
   *
   * 0건 → BILLING_ALLOCATION_MISSING
   * >1건 → BILLING_ALLOCATION_AMBIGUOUS
   * 1건 → create DEBITED chain (unique conflict → 기존과 일치하면 수용)
   */
  async ensureForExistingDelivery(
    queryRunner: QueryRunner,
    orderDelivery: OrderDeliveryEntity,
  ): Promise<InventoryPinBillingChainEntity> {
    // 기존 chain이 있으면 검증 후 반환
    if (orderDelivery.inventoryPinBillingChainId) {
      const existing = await queryRunner.manager.findOne(InventoryPinBillingChainEntity, {
        where: { id: orderDelivery.inventoryPinBillingChainId },
      });
      if (existing && existing.state === 'DEBITED' && Number(existing.currentOrderDeliveryId) === orderDelivery.id) {
        return existing;
      }
    }

    // allocation line → parent allocation 찾기 (order_delivery_id는 line 에만 존재)
    const lines = await queryRunner.query(
      `SELECT l.*, a.id AS parent_allocation_id
       FROM \`order_payment_allocation_line\` l
       JOIN \`order_payment_allocation\` a ON a.id = l.allocation_id
       WHERE l.\`order_delivery_id\` = ?
         AND a.\`released_at\` IS NULL
       ORDER BY l.\`id\` ASC
       FOR SHARE`,
      [orderDelivery.id],
    );

    if (!lines || lines.length === 0) {
      throw new BadRequestException(PIN_INVENTORY_ERROR.BILLING_ALLOCATION_MISSING);
    }
    if (lines.length > 1) {
      throw new BadRequestException(PIN_INVENTORY_ERROR.BILLING_ALLOCATION_AMBIGUOUS);
    }

    const line = lines[0];
    const settleAmount = String(line.gross_settlement_amount ?? line.payable_base ?? 0);
    if (Number(settleAmount) <= 0) {
      throw new BadRequestException(PIN_INVENTORY_ERROR.BILLING_ZERO_AMOUNT);
    }

    // chain 생성 시도
    try {
      const chain = queryRunner.manager.create(InventoryPinBillingChainEntity, {
        walletDebitAllocationId: String(line.parent_allocation_id),
        currentOrderDeliveryId: orderDelivery.id,
        settleAmount,
        state: 'DEBITED',
        version: 1,
      });
      const saved = await queryRunner.manager.save(chain);

      // order_delivery에 chain 연결
      await queryRunner.query(
        'UPDATE `order_delivery` SET `inventory_pin_billing_chain_id` = ? WHERE `id` = ?',
        [saved.id, orderDelivery.id],
      );

      return saved;
    } catch (err: any) {
      // UNIQUE 충돌 → 기존과 일치하면 수용
      if (err?.code === 'ER_DUP_ENTRY') {
        const existing = await queryRunner.manager.findOne(InventoryPinBillingChainEntity, {
          where: { walletDebitAllocationId: String(line.parent_allocation_id) },
        });
        if (
          existing &&
          existing.state === 'DEBITED' &&
          Number(existing.currentOrderDeliveryId) === orderDelivery.id &&
          existing.settleAmount === settleAmount
        ) {
          return existing;
        }
        throw new BadRequestException(PIN_INVENTORY_ERROR.BILLING_CHAIN_CONFLICT);
      }
      throw err;
    }
  }

  /**
   * 외부 API Phase-A: 새 wallet allocation과 함께 chain 생성.
   */
  async createForNewDebit(
    queryRunner: QueryRunner,
    walletDebitAllocationId: string,
    orderDeliveryId: number,
    settleAmount: string,
  ): Promise<InventoryPinBillingChainEntity> {
    const chain = queryRunner.manager.create(InventoryPinBillingChainEntity, {
      walletDebitAllocationId,
      currentOrderDeliveryId: orderDeliveryId,
      settleAmount,
      state: 'DEBITED',
      version: 1,
    });
    return queryRunner.manager.save(chain);
  }
}
