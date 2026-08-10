import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { InventoryPinItemEntity } from '../../entity/inventory.pin.item.entity';
import { InventoryPinEmailAttemptEntity } from '../../entity/inventory.pin.email.attempt.entity';
import { InventoryPinEmailOutboxEntity } from '../../entity/inventory.pin.email.outbox.entity';
import { InventoryPinBillingChainEntity } from '../../entity/inventory.pin.billing.chain.entity';
import { InventoryPinReissueEntity } from '../../entity/inventory.pin.reissue.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderDeliveryRefundEntity } from '../../entity/order.delivery.refund.entity';
import { InventoryPinCryptoService, EncryptionAAD } from './inventory.pin.crypto.service';
import { InventoryPinAllocationService } from './inventory.pin.allocation.service';
import { RefundPoolService } from '../../wallet/application/refund-pool.service';
import { PIN_INVENTORY_ERROR } from '../domain/inventory.pin.error.codes';
import { CryptoCipher } from '../../common/infra/crypto.cipher';

/**
 * CS 서비스: reveal, resend, terminal cancel+refund, void-and-reissue. rev5 §9.
 */
@Injectable()
export class InventoryPinCsService {
  private readonly logger = new Logger(InventoryPinCsService.name);

  constructor(
    @InjectRepository(InventoryPinItemEntity)
    private readonly itemRepo: Repository<InventoryPinItemEntity>,
    @InjectRepository(InventoryPinBillingChainEntity)
    private readonly chainRepo: Repository<InventoryPinBillingChainEntity>,
    @InjectRepository(InventoryPinEmailAttemptEntity)
    private readonly attemptRepo: Repository<InventoryPinEmailAttemptEntity>,
    @InjectRepository(InventoryPinEmailOutboxEntity)
    private readonly outboxRepo: Repository<InventoryPinEmailOutboxEntity>,
    @InjectRepository(InventoryPinReissueEntity)
    private readonly reissueRepo: Repository<InventoryPinReissueEntity>,
    @InjectRepository(OrderDeliveryRefundEntity)
    private readonly refundRepo: Repository<OrderDeliveryRefundEntity>,
    private readonly cryptoService: InventoryPinCryptoService,
    private readonly allocationService: InventoryPinAllocationService,
    private readonly refundPoolService: RefundPoolService,
    private readonly cryptoCipher: CryptoCipher,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * PIN 원문 확인. rev5 §9.2.
   * - 현재 결제 소유자 + DEBITED + item ASSIGNED + fulfillment 비-VOID → 허용
   * - 응답 헤더 Cache-Control: no-store 는 컨트롤러의 @Header 데코레이터가 설정한다
   */
  async revealPin(orderDeliveryId: number, reason: string, operatorUserId: number): Promise<{
    primaryCode: string;
    secondaryCode: string | null;
  }> {
    if (!reason?.trim()) throw new BadRequestException('reason required');

    const item = await this.itemRepo.findOne({
      where: { assignedOrderDeliveryId: orderDeliveryId, status: 'ASSIGNED' },
    });
    if (!item) throw new ForbiddenException(PIN_INVENTORY_ERROR.REVEAL_FORBIDDEN);

    // billing chain 검증
    const delivery = await this.dataSource.getRepository(OrderDeliveryEntity).findOne({
      where: { id: orderDeliveryId },
    });
    if (!delivery?.inventoryPinBillingChainId) {
      throw new ForbiddenException(PIN_INVENTORY_ERROR.REVEAL_FORBIDDEN);
    }
    const chain = await this.chainRepo.findOne({
      where: { id: delivery.inventoryPinBillingChainId },
    });
    if (!chain || chain.state !== 'DEBITED' || Number(chain.currentOrderDeliveryId) !== orderDeliveryId) {
      throw new ForbiddenException(PIN_INVENTORY_ERROR.REVEAL_FORBIDDEN);
    }
    if (delivery.directPinFulfillmentStatus === 'VOID') {
      throw new ForbiddenException(PIN_INVENTORY_ERROR.REVEAL_FORBIDDEN);
    }

    // 감사로그
    this.logger.log(`PIN_REVEAL: operator=${operatorUserId} delivery=${orderDeliveryId} item=${item.id} reason="${reason}"`);

    // 복호화
    const primaryAAD: EncryptionAAD = {
      cryptoContextId: item.cryptoContextId,
      productId: item.productId,
      codeSchemaVersion: item.codeSchemaVersion,
      fieldRole: 'PRIMARY',
    };
    const primaryCode = this.cryptoService.decrypt(item.primaryCodeCiphertext, item.cryptoKeyVersion, primaryAAD);

    let secondaryCode: string | null = null;
    if (item.secondaryCodeCiphertext) {
      const secondaryAAD: EncryptionAAD = {
        cryptoContextId: item.cryptoContextId,
        productId: item.productId,
        codeSchemaVersion: item.codeSchemaVersion,
        fieldRole: 'SECONDARY',
      };
      secondaryCode = this.cryptoService.decrypt(item.secondaryCodeCiphertext, item.cryptoKeyVersion, secondaryAAD);
    }

    return { primaryCode, secondaryCode };
  }

  /**
   * 동일 PIN 재발송. rev5 §8.3.
   */
  async resendSamePin(orderDeliveryId: number, requestKey: string, operatorUserId: number): Promise<{ success: boolean; attemptId?: string }> {
    // 검증: refund/VOID 확인
    const delivery = await this.dataSource.getRepository(OrderDeliveryEntity).findOneOrFail({
      where: { id: orderDeliveryId },
    });
    if (delivery.directPinFulfillmentStatus === 'VOID') {
      throw new BadRequestException(PIN_INVENTORY_ERROR.VOID_STATE_CONFLICT);
    }

    const existingRefund = await this.refundRepo.findOne({
      where: { orderDeliveryId },
    });
    if (existingRefund) {
      throw new BadRequestException(PIN_INVENTORY_ERROR.ALREADY_REFUNDED);
    }

    // active CLAIMED 확인
    const activeClaimed = await this.attemptRepo.findOne({
      where: { orderDeliveryId, status: 'CLAIMED' },
    });
    if (activeClaimed) {
      throw new BadRequestException(PIN_INVENTORY_ERROR.SEND_IN_PROGRESS);
    }

    // outbox 재개: DONE/PAUSED → PENDING
    const outbox = await this.outboxRepo.findOne({ where: { orderDeliveryId } });
    if (outbox) {
      const manualKey = `MANUAL:${requestKey}`;
      await this.outboxRepo.update(outbox.id, {
        state: 'PENDING',
        pendingRequestKey: manualKey,
        dueAt: new Date(),
        ownerToken: null,
      });
    }

    // Note: 실제 발송은 outbox processor가 처리
    return { success: true };
  }

  /**
   * 관리자 terminal 취소 + 환불. rev5 §9.6.
   */
  async terminalCancelRefund(orderDeliveryId: number, reason: string, operatorUserId: number): Promise<{ success: boolean }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 잠금 순서: order_delivery → billing chain → item → active attempt
      const [delivery] = await queryRunner.query(
        `SELECT od.*, opm.order_id AS _resolved_order_id
         FROM \`order_delivery\` od
         JOIN \`order_product_mapping\` opm ON opm.id = od.order_product_mapping_id
         WHERE od.\`id\` = ? FOR UPDATE`,
        [orderDeliveryId],
      );
      if (!delivery.inventory_pin_billing_chain_id) {
        throw new BadRequestException('no billing chain');
      }

      const [chain] = await queryRunner.query(
        'SELECT * FROM `inventory_pin_billing_chain` WHERE `id` = ? FOR UPDATE',
        [delivery.inventory_pin_billing_chain_id],
      );
      if (chain.state !== 'DEBITED') throw new BadRequestException(PIN_INVENTORY_ERROR.ALREADY_REFUNDED);
      if (Number(chain.current_order_delivery_id) !== orderDeliveryId) {
        throw new BadRequestException(PIN_INVENTORY_ERROR.SUPERSEDED_DELIVERY);
      }

      // item
      const items = await queryRunner.query(
        'SELECT * FROM `inventory_pin_item` WHERE `assigned_order_delivery_id` = ? FOR UPDATE',
        [orderDeliveryId],
      );

      // active attempt 확인
      const activeClaimed = await queryRunner.query(
        `SELECT * FROM \`inventory_pin_email_attempt\`
         WHERE \`order_delivery_id\` = ? AND \`status\` = 'CLAIMED'`,
        [orderDeliveryId],
      );
      if (activeClaimed?.length > 0) throw new BadRequestException(PIN_INVENTORY_ERROR.SEND_IN_PROGRESS);

      // item VOID
      if (items?.length > 0) {
        await queryRunner.query(
          `UPDATE \`inventory_pin_item\`
           SET \`status\` = 'VOID', \`voided_at\` = NOW(6), \`void_reason\` = ?
           WHERE \`assigned_order_delivery_id\` = ?`,
          [reason, orderDeliveryId],
        );
      }

      // fulfillment VOID
      await queryRunner.query(
        `UPDATE \`order_delivery\`
         SET \`direct_pin_fulfillment_status\` = 'VOID',
             \`discarded_at\` = NOW(),
             \`status\` = 'CANCEL'
         WHERE \`id\` = ?`,
        [orderDeliveryId],
      );

      // outbox VOID
      await queryRunner.query(
        `UPDATE \`inventory_pin_email_outbox\` SET \`state\` = 'VOID' WHERE \`order_delivery_id\` = ?`,
        [orderDeliveryId],
      );

      // billing REFUNDED
      await queryRunner.query(
        `UPDATE \`inventory_pin_billing_chain\`
         SET \`state\` = 'REFUNDED', \`refunded_at\` = NOW(6), \`version\` = \`version\` + 1
         WHERE \`id\` = ? AND \`state\` = 'DEBITED'`,
        [chain.id],
      );

      // wallet 환불 — 동일 트랜잭션에서 실행 (원자성 보장)
      const resolvedOrderId = delivery._resolved_order_id;
      const settleAmount = Number(chain.settle_amount ?? 0);
      if (settleAmount > 0) {
        if (!resolvedOrderId) {
          // fail-closed: orderId 해석 불가 시 전체 롤백
          throw new BadRequestException(
            `PIN_INVENTORY: cannot resolve orderId for delivery=${orderDeliveryId} — refusing refund (fail-closed)`,
          );
        }
        await this.refundPoolService.refundSettledDiscardToDeposit(
          {
            orderId: resolvedOrderId,
            orderDeliveryId,
            refundAmount: settleAmount,
            idempotencyKeyPrefix: `PIN_INV_REFUND:${chain.id}`,
          },
          queryRunner.manager,
        );
      }

      await queryRunner.commitTransaction();
    } catch (err: any) {
      await queryRunner.rollbackTransaction();
      // 기존 refund가 있으면 멱등
      if (err?.code === 'ER_DUP_ENTRY') {
        return { success: true };
      }
      throw err;
    } finally {
      await queryRunner.release();
    }

    return { success: true };
  }

  /**
   * 폐기 후 신규 발송 (재발급). rev5 §9.5.
   */
  async voidAndReissue(
    orderDeliveryId: number,
    reason: string,
    operatorUserId: number,
    newRecipientEmail?: string,
  ): Promise<{ newOrderDeliveryId: number; newItemId: string }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. policy FOR SHARE
      const [policy] = await queryRunner.query(
        'SELECT * FROM `pin_inventory_policy` WHERE `id` = 1 FOR SHARE',
      );
      if (!policy || !policy.allocation_enabled) {
        throw new BadRequestException(PIN_INVENTORY_ERROR.ALLOCATION_DISABLED);
      }

      // 2. mapping FOR SHARE
      const [delivery] = await queryRunner.query(
        'SELECT * FROM `order_delivery` WHERE `id` = ? FOR UPDATE',
        [orderDeliveryId],
      );
      const [mapping] = await queryRunner.query(
        'SELECT * FROM `order_product_mapping` WHERE `id` = ? FOR SHARE',
        [delivery.order_product_mapping_id],
      );

      // 3. billing chain
      const [chain] = await queryRunner.query(
        'SELECT * FROM `inventory_pin_billing_chain` WHERE `id` = ? FOR UPDATE',
        [delivery.inventory_pin_billing_chain_id],
      );
      if (!chain || chain.state !== 'DEBITED') {
        throw new BadRequestException(PIN_INVENTORY_ERROR.ALREADY_REFUNDED);
      }
      if (Number(chain.current_order_delivery_id) !== orderDeliveryId) {
        throw new BadRequestException(PIN_INVENTORY_ERROR.SUPERSEDED_DELIVERY);
      }

      // 4. old item
      const [oldItem] = await queryRunner.query(
        'SELECT * FROM `inventory_pin_item` WHERE `assigned_order_delivery_id` = ? FOR UPDATE',
        [orderDeliveryId],
      );

      // 5. new AVAILABLE item (같은 codeSchemaVersion)
      const snapshot = typeof mapping.direct_pin_email_snapshot === 'string'
        ? JSON.parse(mapping.direct_pin_email_snapshot)
        : mapping.direct_pin_email_snapshot;
      const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const today = kstNow.toISOString().slice(0, 10);

      const newItems = await queryRunner.query(
        `SELECT * FROM \`inventory_pin_item\`
         WHERE \`product_id\` = ? AND \`code_schema_version\` = ?
           AND \`status\` = 'AVAILABLE'
           AND (\`expires_on\` IS NULL OR \`expires_on\` >= ?)
           AND \`deleted_at\` IS NULL
         ORDER BY \`expires_on\` IS NULL ASC, \`expires_on\` ASC, \`id\` ASC
         LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [mapping.product_id, snapshot?.codeSchemaVersion ?? oldItem.code_schema_version, today],
      );
      if (!newItems?.length) {
        throw new BadRequestException(PIN_INVENTORY_ERROR.OUT_OF_STOCK);
      }
      const newItem = newItems[0];

      // 6. active attempt 검증
      const activeClaimed = await queryRunner.query(
        `SELECT * FROM \`inventory_pin_email_attempt\`
         WHERE \`order_delivery_id\` = ? AND \`status\` = 'CLAIMED'`,
        [orderDeliveryId],
      );
      if (activeClaimed?.length > 0) {
        throw new BadRequestException(PIN_INVENTORY_ERROR.SEND_IN_PROGRESS);
      }

      // 7. old item/fulfillment VOID
      await queryRunner.query(
        `UPDATE \`inventory_pin_item\`
         SET \`status\` = 'VOID', \`voided_at\` = NOW(6), \`void_reason\` = ?
         WHERE \`id\` = ?`,
        [reason, oldItem.id],
      );
      await queryRunner.query(
        `UPDATE \`order_delivery\`
         SET \`direct_pin_fulfillment_status\` = 'VOID', \`discarded_at\` = NOW()
         WHERE \`id\` = ?`,
        [orderDeliveryId],
      );
      // old outbox VOID
      await queryRunner.query(
        `UPDATE \`inventory_pin_email_outbox\` SET \`state\` = 'VOID' WHERE \`order_delivery_id\` = ?`,
        [orderDeliveryId],
      );

      // 8. 신규 OrderDelivery 생성 — newRecipientEmail은 평문이므로 암호화 후 저장
      const recipientEmail = newRecipientEmail
        ? this.cryptoCipher.encryptDeliveryTarget(newRecipientEmail)
        : delivery.delivery_target;
      const now = new Date();
      const newDeliveryResult = await queryRunner.query(
        `INSERT INTO \`order_delivery\`
         (\`status\`, \`order_product_mapping_id\`, \`delivery_method\`, \`delivery_target\`,
          \`original_delivery_target\`, \`send_request_at\`, \`coupon_status\`,
          \`direct_pin_fulfillment_status\`, \`inventory_pin_billing_chain_id\`,
          \`delivery_target_version\`, \`replaced_from_id\`,
          \`created_at\`, \`updated_at\`)
         VALUES ('WAIT', ?, 'EMAIL', ?, ?, ?, 'NOT_USED', 'PENDING_SEND', ?, 0, ?,
                 NOW(6), NOW(6))`,
        [
          delivery.order_product_mapping_id,
          recipientEmail,
          recipientEmail,
          now,
          chain.id,
          orderDeliveryId,
        ],
      );
      const newOrderDeliveryId = Number(newDeliveryResult.insertId);

      // 9. new item ASSIGNED
      await queryRunner.query(
        `UPDATE \`inventory_pin_item\`
         SET \`status\` = 'ASSIGNED', \`assigned_order_delivery_id\` = ?, \`assigned_at\` = NOW(6)
         WHERE \`id\` = ? AND \`status\` = 'AVAILABLE'`,
        [newOrderDeliveryId, newItem.id],
      );

      // 10. billing chain current owner 이전
      await queryRunner.query(
        `UPDATE \`inventory_pin_billing_chain\`
         SET \`current_order_delivery_id\` = ?, \`version\` = \`version\` + 1
         WHERE \`id\` = ? AND \`current_order_delivery_id\` = ?`,
        [newOrderDeliveryId, chain.id, orderDeliveryId],
      );

      // 11. new outbox
      await queryRunner.query(
        `INSERT INTO \`inventory_pin_email_outbox\`
         (\`order_delivery_id\`, \`state\`, \`due_at\`, \`attempt_count\`, \`pending_request_key\`,
          \`created_at\`, \`updated_at\`)
         VALUES (?, 'PENDING', NOW(6), 0, ?, NOW(6), NOW(6))`,
        [newOrderDeliveryId, `INITIAL:${newOrderDeliveryId}`],
      );

      // 12. reissue 이력
      await queryRunner.query(
        `INSERT INTO \`inventory_pin_reissue\`
         (\`old_order_delivery_id\`, \`new_order_delivery_id\`,
          \`old_inventory_pin_item_id\`, \`new_inventory_pin_item_id\`,
          \`inventory_pin_billing_chain_id\`, \`status\`, \`reason\`, \`created_by_user_id\`,
          \`created_at\`, \`updated_at\`)
         VALUES (?, ?, ?, ?, ?, 'COMPLETED', ?, ?, NOW(6), NOW(6))`,
        [orderDeliveryId, newOrderDeliveryId, oldItem.id, newItem.id, chain.id, reason, operatorUserId],
      );

      await queryRunner.commitTransaction();
      return { newOrderDeliveryId, newItemId: String(newItem.id) };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }
}
