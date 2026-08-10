import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { InventoryPinItemEntity } from '../../entity/inventory.pin.item.entity';
import { InventoryPinEmailAttemptEntity } from '../../entity/inventory.pin.email.attempt.entity';
import { InventoryPinEmailOutboxEntity } from '../../entity/inventory.pin.email.outbox.entity';
import { InventoryPinBillingChainEntity } from '../../entity/inventory.pin.billing.chain.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { InventoryPinCryptoService, EncryptionAAD } from './inventory.pin.crypto.service';
import { InventoryPinPolicyService } from './inventory.pin.policy.service';
import { DirectPinMailSender, DirectPinMailResult } from './direct.pin.mail.sender';
import { renderDirectPinEmail, DirectPinRenderInput } from './direct.pin.email.template';
import { DirectPinEmailSnapshot } from '../domain/direct.pin.email.snapshot';
import { PIN_INVENTORY_ERROR } from '../domain/inventory.pin.error.codes';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { randomUUID } from 'crypto';

/**
 * 직접 PIN 이메일 발송 서비스 (send-claim protocol). rev5 §7.3 + §8.
 *
 * 1. mapping FOR SHARE → delivery FOR UPDATE → chain → item → attempt insert (CLAIMED)
 * 2. commit
 * 3. final invocation fence: send policy fail-closed 읽기
 * 4. PIN/recipient 복호화 → 렌더링 → DirectPinMailSender
 * 5. outcome CAS
 */

/**
 * 수신 이메일 복호화 결과를 검증하는 순수 함수.
 * null(복호화 실패)이면 throw — 암호문 fallback은 절대 허용 안 함 (fail-closed).
 */
export function resolveRecipientOrThrow(decryptResult: string | null, deliveryId: number): string {
  if (!decryptResult) {
    throw new BadRequestException(
      `PIN_INVENTORY_DECRYPT_FAILED: delivery_target decryption failed for delivery=${deliveryId}. ` +
      `Cannot send email with undecryptable address.`,
    );
  }
  return decryptResult;
}

@Injectable()
export class InventoryPinSendService {
  private readonly logger = new Logger(InventoryPinSendService.name);

  constructor(
    @InjectRepository(InventoryPinEmailAttemptEntity)
    private readonly attemptRepo: Repository<InventoryPinEmailAttemptEntity>,
    @InjectRepository(InventoryPinEmailOutboxEntity)
    private readonly outboxRepo: Repository<InventoryPinEmailOutboxEntity>,
    private readonly cryptoService: InventoryPinCryptoService,
    private readonly cryptoCipher: CryptoCipher,
    private readonly policyService: InventoryPinPolicyService,
    private readonly mailSender: DirectPinMailSender,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 주어진 배송건의 outbox를 처리한다.
   * 동기 요청과 worker가 같은 경로를 사용한다.
   */
  async processOutbox(orderDeliveryId: number): Promise<{ attemptId: string; outcome: string }> {
    // ── Phase 1: claim transaction ──
    const claimResult = await this.claim(orderDeliveryId);
    if (claimResult.alreadyTerminal) {
      return { attemptId: claimResult.attemptId, outcome: claimResult.existingOutcome! };
    }

    // ── Phase 2: final invocation fence (DB 트랜잭션 밖) ──
    const sendPolicy = await this.policyService.readSendPolicyFailClosed();
    if (!sendPolicy.sendEnabled) {
      // send-stop: CLAIMED → UNKNOWN, outbox → PAUSED
      await this.tokenCasToUnknown(
        claimResult.attemptId,
        claimResult.claimToken,
        PIN_INVENTORY_ERROR.SEND_STOPPED_AFTER_CLAIM,
        orderDeliveryId,
      );
      return { attemptId: claimResult.attemptId, outcome: 'UNKNOWN' };
    }

    // ── Phase 3: decrypt + render + send ──
    try {
      const decrypted = await this.decryptAndRender(claimResult);
      const mailResult = await this.mailSender.send({
        recipientEmail: decrypted.recipientEmail,
        subject: decrypted.subject,
        htmlBody: decrypted.htmlBody,
        fromEmail: decrypted.fromEmail,
      });

      // ── Phase 4: outcome CAS ──
      await this.applyOutcome(claimResult, mailResult, orderDeliveryId);
      return { attemptId: claimResult.attemptId, outcome: mailResult.outcome };
    } catch (err) {
      // render/send 실패 → UNKNOWN
      this.logger.error('DirectPinSend: unexpected error during send', err instanceof Error ? err.message : '');
      await this.tokenCasToUnknown(
        claimResult.attemptId,
        claimResult.claimToken,
        'SEND_ERROR',
        orderDeliveryId,
      );
      return { attemptId: claimResult.attemptId, outcome: 'UNKNOWN' };
    }
  }

  private async claim(orderDeliveryId: number): Promise<ClaimResult> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. mapping FOR SHARE
      const [mapping] = await queryRunner.query(
        `SELECT opm.* FROM \`order_product_mapping\` opm
         JOIN \`order_delivery\` od ON od.order_product_mapping_id = opm.id
         WHERE od.id = ? FOR SHARE`,
        [orderDeliveryId],
      );

      // 2. delivery FOR UPDATE
      const [delivery] = await queryRunner.query(
        'SELECT * FROM `order_delivery` WHERE `id` = ? FOR UPDATE',
        [orderDeliveryId],
      );

      // 3. billing chain
      if (!delivery.inventory_pin_billing_chain_id) {
        throw new BadRequestException('billing chain not linked');
      }
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

      // 4. item
      const [item] = await queryRunner.query(
        'SELECT * FROM `inventory_pin_item` WHERE `assigned_order_delivery_id` = ? FOR UPDATE',
        [orderDeliveryId],
      );
      if (!item || item.status !== 'ASSIGNED') {
        throw new BadRequestException('no assigned item');
      }

      // 5. outbox
      const [outbox] = await queryRunner.query(
        'SELECT * FROM `inventory_pin_email_outbox` WHERE `order_delivery_id` = ? FOR UPDATE',
        [orderDeliveryId],
      );
      const requestKey = outbox?.pending_request_key || `INITIAL:${orderDeliveryId}`;

      // 6. 기존 attempt 확인
      const existingAttempts = await queryRunner.query(
        'SELECT * FROM `inventory_pin_email_attempt` WHERE `order_delivery_id` = ? AND `request_key` = ?',
        [orderDeliveryId, requestKey],
      );
      if (existingAttempts?.length > 0) {
        const ea = existingAttempts[0];
        // CLAIMED 재사용 금지: 동시 실행 또는 장애 시 같은 PIN 중복 노출 방지
        if (ea.status === 'CLAIMED') {
          throw new BadRequestException(PIN_INVENTORY_ERROR.SEND_IN_PROGRESS);
        }
        // terminal (SENT/FAILED/UNKNOWN) → 이미 처리 완료, 결과만 반환
        await queryRunner.commitTransaction();
        return {
          attemptId: String(ea.id),
          claimToken: ea.claim_token,
          alreadyTerminal: true,
          existingOutcome: ea.status,
          item, mapping, delivery, chain,
        };
      }

      // 다른 request_key의 active CLAIMED 확인
      const activeClaimed = await queryRunner.query(
        `SELECT * FROM \`inventory_pin_email_attempt\`
         WHERE \`order_delivery_id\` = ? AND \`status\` = 'CLAIMED'`,
        [orderDeliveryId],
      );
      if (activeClaimed?.length > 0) {
        throw new BadRequestException(PIN_INVENTORY_ERROR.SEND_IN_PROGRESS);
      }

      // 7. CLAIMED attempt insert
      const claimToken = randomUUID();
      const now = new Date();
      const targetVersion = delivery.delivery_target_version ?? 0;
      const attemptType = requestKey.startsWith('INITIAL:') ? 'INITIAL' : 'RESEND';

      const insertResult = await queryRunner.query(
        `INSERT INTO \`inventory_pin_email_attempt\`
         (\`inventory_pin_item_id\`, \`order_delivery_id\`, \`request_key\`,
          \`attempt_type\`, \`status\`, \`target_version\`, \`claim_token\`, \`claimed_at\`,
          \`created_at\`, \`updated_at\`)
         VALUES (?, ?, ?, ?, 'CLAIMED', ?, ?, ?, NOW(6), NOW(6))`,
        [item.id, orderDeliveryId, requestKey, attemptType, targetVersion, claimToken, now],
      );
      const attemptId = String(insertResult.insertId);

      // 8. fulfillment SENDING (최초 SENT가 아닌 경우)
      if (delivery.direct_pin_fulfillment_status !== 'SENT') {
        await queryRunner.query(
          `UPDATE \`order_delivery\`
           SET \`direct_pin_fulfillment_status\` = 'SENDING',
               \`direct_pin_latest_attempt_id\` = ?
           WHERE \`id\` = ?`,
          [attemptId, orderDeliveryId],
        );
      }

      // outbox CLAIMED
      if (outbox) {
        await queryRunner.query(
          `UPDATE \`inventory_pin_email_outbox\`
           SET \`state\` = 'CLAIMED', \`owner_token\` = ?, \`lease_until\` = ?
           WHERE \`id\` = ?`,
          [claimToken, new Date(now.getTime() + 5 * 60 * 1000), outbox.id],
        );
      }

      await queryRunner.commitTransaction();

      return {
        attemptId,
        claimToken,
        alreadyTerminal: false,
        item, mapping, delivery, chain,
      };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  private async decryptAndRender(claim: ClaimResult): Promise<DecryptedSendInput> {
    const item = claim.item;
    const mapping = claim.mapping;
    const delivery = claim.delivery;

    const snapshot: DirectPinEmailSnapshot = typeof mapping.direct_pin_email_snapshot === 'string'
      ? JSON.parse(mapping.direct_pin_email_snapshot)
      : mapping.direct_pin_email_snapshot;

    // PIN 복호화
    const primaryAAD: EncryptionAAD = {
      cryptoContextId: item.crypto_context_id,
      productId: Number(item.product_id),
      codeSchemaVersion: item.code_schema_version,
      fieldRole: 'PRIMARY',
    };
    const primaryCode = this.cryptoService.decrypt(item.primary_code_ciphertext, item.crypto_key_version, primaryAAD);

    let secondaryCode: string | null = null;
    if (item.secondary_code_ciphertext) {
      const secondaryAAD: EncryptionAAD = {
        cryptoContextId: item.crypto_context_id,
        productId: Number(item.product_id),
        codeSchemaVersion: item.code_schema_version,
        fieldRole: 'SECONDARY',
      };
      secondaryCode = this.cryptoService.decrypt(item.secondary_code_ciphertext, item.crypto_key_version, secondaryAAD);
    }

    // 수신 이메일 복호화 — fail-closed (암호문 fallback 금지)
    let rawDecrypt: string | null;
    try {
      rawDecrypt = this.cryptoCipher.decryptDeliveryTarget(delivery.delivery_target);
    } catch {
      rawDecrypt = null;
    }
    const recipientEmail = resolveRecipientOrThrow(rawDecrypt, delivery.id);

    // 만료일
    const validEndDate = delivery.expire_at
      ? new Date(delivery.expire_at).toISOString().slice(0, 10)
      : null;

    const renderInput: DirectPinRenderInput = {
      snapshot,
      sendContent: mapping.send_content || '',
      productName: mapping.snapshot_product_name || '',
      brandName: mapping.snapshot_product_brand_name || '',
      primaryCode,
      secondaryCode,
      validEndDate,
    };
    const htmlBody = renderDirectPinEmail(renderInput);

    return {
      recipientEmail,
      subject: mapping.send_title || snapshot.faceValueAmount + ' ' + snapshot.currencyCode + ' Gift',
      htmlBody,
      fromEmail: mapping.from_email || '',
    };
  }

  private async applyOutcome(claim: ClaimResult, result: DirectPinMailResult, orderDeliveryId: number): Promise<void> {
    const now = new Date();

    // 잠금 순서: delivery → attempt → outbox (전역 규약 준수)
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. delivery FOR UPDATE — 전역 순서에서 attempt·outbox보다 선행
      const [delivery] = await queryRunner.query(
        'SELECT * FROM `order_delivery` WHERE `id` = ? FOR UPDATE',
        [orderDeliveryId],
      );

      // 2. attempt CAS: CLAIMED + token → SENT/FAILED/UNKNOWN
      const attemptUpdate = await queryRunner.query(
        `UPDATE \`inventory_pin_email_attempt\`
         SET \`status\` = ?, \`completed_at\` = ?, \`provider_code\` = ?, \`error_code\` = ?
         WHERE \`id\` = ? AND \`status\` = 'CLAIMED' AND \`claim_token\` = ?`,
        [result.outcome, now, result.providerCode ?? null, result.errorCode ?? null, claim.attemptId, claim.claimToken],
      );

      if (attemptUpdate.affectedRows !== 1) {
        await queryRunner.rollbackTransaction();
        this.logger.warn(`Attempt CAS failed for ${claim.attemptId} — late outcome`);
        return;
      }

      const currentFulfillment = delivery.direct_pin_fulfillment_status;

      if (result.outcome === 'SENT') {
        // 최초 SENT
        await queryRunner.query(
          `UPDATE \`order_delivery\` SET
            \`direct_pin_fulfillment_status\` = COALESCE(?, \`direct_pin_fulfillment_status\`),
            \`direct_pin_sent_at\` = COALESCE(?, \`direct_pin_sent_at\`),
            \`direct_pin_latest_attempt_id\` = ?,
            \`status\` = COALESCE(?, \`status\`),
            \`actual_send_at\` = COALESCE(?, \`actual_send_at\`)
          WHERE \`id\` = ?`,
          [
            currentFulfillment !== 'SENT' ? 'SENT' : null,
            currentFulfillment !== 'SENT' ? now : null,
            claim.attemptId,
            currentFulfillment !== 'SENT' ? 'COMPLETE' : null,
            currentFulfillment !== 'SENT' ? now : null,
            orderDeliveryId,
          ],
        );

        // outbox DONE
        await queryRunner.query(
          `UPDATE \`inventory_pin_email_outbox\` SET \`state\` = 'DONE' WHERE \`order_delivery_id\` = ?`,
          [orderDeliveryId],
        );
      } else if (result.outcome === 'FAILED') {
        if (currentFulfillment !== 'SENT') {
          await queryRunner.query(
            `UPDATE \`order_delivery\` SET
              \`direct_pin_fulfillment_status\` = 'FAILED',
              \`direct_pin_latest_attempt_id\` = ?,
              \`status\` = 'FAIL',
              \`failed_at\` = ?
            WHERE \`id\` = ?`,
            [claim.attemptId, now, orderDeliveryId],
          );
        }
        // outbox: retry or PAUSED
        await this.handleFailedOutbox(queryRunner, orderDeliveryId, result.errorCode);
      } else {
        // UNKNOWN
        if (currentFulfillment !== 'SENT') {
          await queryRunner.query(
            `UPDATE \`order_delivery\` SET
              \`direct_pin_fulfillment_status\` = 'UNKNOWN',
              \`direct_pin_latest_attempt_id\` = ?
            WHERE \`id\` = ?`,
            [claim.attemptId, orderDeliveryId],
          );
        }
        // outbox PAUSED — UNKNOWN은 자동 재시도 금지
        await queryRunner.query(
          `UPDATE \`inventory_pin_email_outbox\` SET \`state\` = 'PAUSED', \`last_error_code\` = ?
           WHERE \`order_delivery_id\` = ?`,
          ['UNKNOWN', orderDeliveryId],
        );
      }

      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  private async handleFailedOutbox(queryRunner: any, orderDeliveryId: number, errorCode?: string): Promise<void> {
    const maxRetry = Number(process.env.PIN_INVENTORY_EMAIL_AUTO_RETRY_MAX ?? 3);
    const backoffs = [60_000, 300_000, 900_000]; // 1m, 5m, 15m

    const [outbox] = await queryRunner.query(
      'SELECT * FROM `inventory_pin_email_outbox` WHERE `order_delivery_id` = ? FOR UPDATE',
      [orderDeliveryId],
    );
    if (!outbox) return;

    const count = (outbox.attempt_count ?? 0) + 1;
    if (count >= maxRetry) {
      await queryRunner.query(
        `UPDATE \`inventory_pin_email_outbox\`
         SET \`state\` = 'PAUSED', \`attempt_count\` = ?, \`last_error_code\` = ?, \`owner_token\` = NULL
         WHERE \`id\` = ?`,
        [count, errorCode ?? 'MAX_RETRY', outbox.id],
      );
    } else {
      const backoff = backoffs[count - 1] ?? 900_000;
      const nextKey = `AUTO:${outbox.id}:${count}`;
      await queryRunner.query(
        `UPDATE \`inventory_pin_email_outbox\`
         SET \`state\` = 'PENDING',
             \`attempt_count\` = ?,
             \`due_at\` = ?,
             \`pending_request_key\` = ?,
             \`last_error_code\` = ?,
             \`owner_token\` = NULL
         WHERE \`id\` = ?`,
        [count, new Date(Date.now() + backoff), nextKey, errorCode, outbox.id],
      );
    }
  }

  private async tokenCasToUnknown(
    attemptId: string,
    claimToken: string,
    errorCode: string,
    orderDeliveryId: number,
  ): Promise<void> {
    await this.attemptRepo
      .createQueryBuilder()
      .update(InventoryPinEmailAttemptEntity)
      .set({ status: 'UNKNOWN', completedAt: new Date(), errorCode })
      .where('id = :id AND status = :status AND claimToken = :token', {
        id: attemptId, status: 'CLAIMED', token: claimToken,
      })
      .execute();

    await this.outboxRepo
      .createQueryBuilder()
      .update(InventoryPinEmailOutboxEntity)
      .set({ state: 'PAUSED', lastErrorCode: errorCode })
      .where('orderDeliveryId = :orderDeliveryId', { orderDeliveryId })
      .execute();
  }
}

interface ClaimResult {
  attemptId: string;
  claimToken: string;
  alreadyTerminal: boolean;
  existingOutcome?: string;
  item: any;
  mapping: any;
  delivery: any;
  chain: any;
}

interface DecryptedSendInput {
  recipientEmail: string;
  subject: string;
  htmlBody: string;
  fromEmail: string;
}
