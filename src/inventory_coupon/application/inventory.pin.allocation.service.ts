import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryRunner, Repository } from 'typeorm';
import { InventoryPinItemEntity } from '../../entity/inventory.pin.item.entity';
import { InventoryPinEmailOutboxEntity } from '../../entity/inventory.pin.email.outbox.entity';
import { InventoryPinBillingChainEntity } from '../../entity/inventory.pin.billing.chain.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { PinInventoryPolicyEntity } from '../../entity/pin.inventory.policy.entity';
import { InventoryCouponProductConfigEntity } from '../../entity/inventory.coupon.product.config.entity';
import { InventoryPinBillingChainService } from './inventory.pin.billing.chain.service';
import { PIN_INVENTORY_ERROR } from '../domain/inventory.pin.error.codes';
import { DirectPinEmailSnapshot } from '../domain/direct.pin.email.snapshot';
import { ulid } from 'ulid';

export interface AllocationResult {
  item: InventoryPinItemEntity;
  outbox: InventoryPinEmailOutboxEntity;
  billingChain: InventoryPinBillingChainEntity;
  alreadyExisted: boolean;
}

/**
 * PIN 원자적 할당 서비스. rev5 §7.
 *
 * 모든 채널(관리자, 배치, 외부 API)이 이 서비스의 allocate()만 사용한다.
 * 전역 잠금 순서: api_app → pin_inventory_policy → order_product_mapping → order_delivery
 *   → inventory_pin_billing_chain → inventory_pin_item → email_attempt → outbox
 */
@Injectable()
export class InventoryPinAllocationService {
  private readonly logger = new Logger(InventoryPinAllocationService.name);

  constructor(
    @InjectRepository(InventoryPinItemEntity)
    private readonly itemRepo: Repository<InventoryPinItemEntity>,
    @InjectRepository(InventoryPinEmailOutboxEntity)
    private readonly outboxRepo: Repository<InventoryPinEmailOutboxEntity>,
    private readonly billingChainService: InventoryPinBillingChainService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 배송건에 PIN을 할당하고 outbox를 생성한다. rev5 §7.1.
   *
   * 같은 orderDeliveryId로 호출하면 기존 assignment를 반환한다 (멱등).
   * allocation 중단이면 기존 assignment만 반환하고 신규 할당은 거부한다.
   */
  async allocate(orderDelivery: OrderDeliveryEntity): Promise<AllocationResult> {
    // ── 1. 잠금 없는 빠른 경로 ──
    const existing = await this.findExistingAssignment(orderDelivery.id);
    if (existing) return existing;

    // ── 2. 트랜잭션 할당 ──
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // policy FOR SHARE
      const policy = await this.lockPolicyForShare(queryRunner);
      // mapping FOR SHARE
      const mapping = await this.lockMappingForShare(queryRunner, orderDelivery.orderProductMappingId);
      // order_delivery FOR UPDATE
      const lockedDelivery = await this.lockDeliveryForUpdate(queryRunner, orderDelivery.id);

      // 잠금 후 재검증
      const existingAfterLock = await this.findExistingAssignmentInTx(queryRunner, lockedDelivery.id);
      if (existingAfterLock) {
        await queryRunner.commitTransaction();
        return existingAfterLock;
      }

      // 신규 할당 — policy 검증
      if (!policy || !policy.allocation_enabled) {
        throw new BadRequestException(PIN_INVENTORY_ERROR.ALLOCATION_DISABLED);
      }

      // 스냅샷 검증 — raw SQL은 snake_case 컬럼명 반환
      const snapshotRaw = mapping.direct_pin_email_snapshot;
      let snapshot: DirectPinEmailSnapshot | null = snapshotRaw
        ? (typeof snapshotRaw === 'string'
            ? JSON.parse(snapshotRaw)
            : snapshotRaw)
        : null;

      // snapshot이 없으면 config에서 즉석 빌드하여 mapping에 원자적 저장 (최초 allocation 시 1회)
      if (!snapshot) {
        const configs = await queryRunner.query(
          'SELECT * FROM `inventory_coupon_product_config` WHERE `product_id` = ?',
          [mapping.product_id],
        );
        const config = configs?.[0];
        if (!config) {
          throw new BadRequestException(PIN_INVENTORY_ERROR.CONFIG_REQUIRED);
        }
        snapshot = {
          version: 1,
          productConfigVersion: Number(config.version),
          codeSchemaVersion: Number(config.code_schema_version),
          faceValueAmount: String(config.face_value_amount),
          currencyCode: config.currency_code,
          primaryCodeLabel: config.primary_code_label,
          secondaryCodeLabel: config.secondary_code_label ?? null,
          howToUse: config.how_to_use,
          notice: config.notice,
          validityDays: Number(config.validity_days ?? 0),
          validityStartsNextDay: Boolean(config.validity_starts_next_day),
          locale: 'en',
        };
        await queryRunner.query(
          'UPDATE `order_product_mapping` SET `direct_pin_email_snapshot` = ? WHERE `id` = ?',
          [JSON.stringify(snapshot), mapping.id],
        );
        this.logger.log(
          `[PIN_ALLOC] built snapshot for mapping=${mapping.id}, product=${mapping.product_id}, configVersion=${config.version}`,
        );
      }

      // billing chain 확보
      const billingChain = await this.billingChainService.ensureForExistingDelivery(queryRunner, lockedDelivery);

      // AVAILABLE item 선택: 같은 product_id, 같은 codeSchemaVersion, 만료일 우선, id 순
      // KST 기준 오늘 날짜 사용 (UTC 대신)
      const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const today = kstNow.toISOString().slice(0, 10);
      const items = await queryRunner.query(
        `SELECT * FROM \`inventory_pin_item\`
         WHERE \`product_id\` = ?
           AND \`code_schema_version\` = ?
           AND \`status\` = 'AVAILABLE'
           AND (\`expires_on\` IS NULL OR \`expires_on\` >= ?)
           AND \`deleted_at\` IS NULL
         ORDER BY \`expires_on\` IS NULL ASC, \`expires_on\` ASC, \`id\` ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [mapping.product_id, snapshot.codeSchemaVersion, today],
      );

      if (!items || items.length === 0) {
        throw new BadRequestException(PIN_INVENTORY_ERROR.OUT_OF_STOCK);
      }

      const rawItem = items[0];
      const now = new Date();

      // item: AVAILABLE → ASSIGNED
      await queryRunner.query(
        `UPDATE \`inventory_pin_item\`
         SET \`status\` = 'ASSIGNED',
             \`assigned_order_delivery_id\` = ?,
             \`assigned_at\` = ?
         WHERE \`id\` = ? AND \`status\` = 'AVAILABLE' AND \`assigned_order_delivery_id\` IS NULL`,
        [lockedDelivery.id, now, rawItem.id],
      );

      // order_delivery: fulfillment PENDING_SEND + chain 연결 + expireAt 계산
      const expireAt = this.calculateExpireAt(rawItem, snapshot, now);
      await queryRunner.query(
        `UPDATE \`order_delivery\`
         SET \`direct_pin_fulfillment_status\` = 'PENDING_SEND',
             \`inventory_pin_billing_chain_id\` = ?,
             \`expire_at\` = ?
         WHERE \`id\` = ?`,
        [billingChain.id, expireAt, lockedDelivery.id],
      );

      // outbox PENDING
      const outbox = queryRunner.manager.create(InventoryPinEmailOutboxEntity, {
        orderDeliveryId: lockedDelivery.id,
        state: 'PENDING',
        dueAt: now,
        attemptCount: 0,
        pendingRequestKey: `INITIAL:${lockedDelivery.id}`,
      });
      const savedOutbox = await queryRunner.manager.save(outbox);

      await queryRunner.commitTransaction();

      // 결과 조립
      const savedItem = await this.itemRepo.findOneOrFail({ where: { id: String(rawItem.id) } });
      return {
        item: savedItem,
        outbox: savedOutbox,
        billingChain,
        alreadyExisted: false,
      };
    } catch (err: any) {
      await queryRunner.rollbackTransaction();

      // UNIQUE 충돌 → 수렴 시도
      if (err?.code === 'ER_DUP_ENTRY') {
        const converged = await this.findExistingAssignment(orderDelivery.id);
        if (converged) return converged;
        throw new BadRequestException(PIN_INVENTORY_ERROR.ASSIGNMENT_CONFLICT);
      }
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  private async findExistingAssignment(orderDeliveryId: number): Promise<AllocationResult | null> {
    const item = await this.itemRepo.findOne({
      where: { assignedOrderDeliveryId: orderDeliveryId, status: 'ASSIGNED' },
    });
    if (!item) return null;
    const outbox = await this.outboxRepo.findOne({ where: { orderDeliveryId } });
    if (!outbox) return null;
    const chain = await this.dataSource.getRepository(InventoryPinBillingChainEntity).findOne({
      where: { currentOrderDeliveryId: orderDeliveryId },
    });
    // simplified: return the pair
    return { item, outbox, billingChain: chain!, alreadyExisted: true };
  }

  private async findExistingAssignmentInTx(queryRunner: QueryRunner, orderDeliveryId: number): Promise<AllocationResult | null> {
    const items = await queryRunner.query(
      'SELECT * FROM `inventory_pin_item` WHERE `assigned_order_delivery_id` = ? AND `status` = ?',
      [orderDeliveryId, 'ASSIGNED'],
    );
    if (!items || items.length === 0) return null;
    const outboxes = await queryRunner.query(
      'SELECT * FROM `inventory_pin_email_outbox` WHERE `order_delivery_id` = ?',
      [orderDeliveryId],
    );
    if (!outboxes || outboxes.length === 0) return null;
    // 정상 쌍 → 기존 결과 반환
    const item = Object.assign(new InventoryPinItemEntity(), items[0]) as InventoryPinItemEntity;
    const outbox = Object.assign(new InventoryPinEmailOutboxEntity(), outboxes[0]) as InventoryPinEmailOutboxEntity;
    const chains = await queryRunner.query(
      'SELECT * FROM `inventory_pin_billing_chain` WHERE `current_order_delivery_id` = ?',
      [orderDeliveryId],
    );
    const chain = chains?.length
      ? Object.assign(new InventoryPinBillingChainEntity(), chains[0]) as InventoryPinBillingChainEntity
      : null;
    return { item, outbox, billingChain: chain!, alreadyExisted: true };
  }

  private async lockPolicyForShare(queryRunner: QueryRunner): Promise<any> {
    const rows = await queryRunner.query('SELECT * FROM `pin_inventory_policy` WHERE `id` = 1 FOR SHARE');
    return rows?.[0] ?? null;
  }

  private async lockMappingForShare(queryRunner: QueryRunner, mappingId: number): Promise<any> {
    const rows = await queryRunner.query(
      'SELECT * FROM `order_product_mapping` WHERE `id` = ? FOR SHARE',
      [mappingId],
    );
    if (!rows || rows.length === 0) throw new BadRequestException('order_product_mapping not found');
    return rows[0];
  }

  private async lockDeliveryForUpdate(queryRunner: QueryRunner, deliveryId: number): Promise<OrderDeliveryEntity> {
    const rows = await queryRunner.query(
      'SELECT * FROM `order_delivery` WHERE `id` = ? FOR UPDATE',
      [deliveryId],
    );
    if (!rows || rows.length === 0) throw new BadRequestException('order_delivery not found');
    return Object.assign(new OrderDeliveryEntity(), rows[0]) as OrderDeliveryEntity;
  }

  /**
   * 만료일 계산. rev5 §8.5.
   * item.expiresOn이 있으면 KST 종료시각, 없으면 스냅샷 정책으로 계산.
   */
  private calculateExpireAt(rawItem: any, snapshot: DirectPinEmailSnapshot, assignedAt: Date): Date | null {
    const expiresOn = rawItem.expires_on ?? rawItem.expiresOn;
    if (expiresOn) {
      // KST 해당 날짜 23:59:59
      const dateStr = typeof expiresOn === 'string' ? expiresOn : expiresOn.toISOString().slice(0, 10);
      return new Date(`${dateStr}T23:59:59+09:00`);
    }

    if (snapshot.validityDays && snapshot.validityDays >= 1) {
      // KST 기준일 계산
      const kstOffset = 9 * 60 * 60 * 1000;
      const kstDate = new Date(assignedAt.getTime() + kstOffset);
      const baseDateStr = kstDate.toISOString().slice(0, 10);
      const baseDate = new Date(baseDateStr + 'T00:00:00+09:00');

      const addDays = snapshot.validityStartsNextDay
        ? snapshot.validityDays
        : snapshot.validityDays - 1;
      const expireDate = new Date(baseDate.getTime() + addDays * 24 * 60 * 60 * 1000);
      // KST 종료시각
      return new Date(expireDate.getTime() + 23 * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000);
    }

    return null;
  }
}
