import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { InventoryPinSendService } from './application/inventory.pin.send.service';

/**
 * Outbox worker schedule: PENDING outbox rows를 주기적으로 claim → send 처리.
 *
 * - 30초마다 실행 (다른 cron과 동시 trigger 회피를 위해 10초 offset)
 * - SKIP LOCKED + CAS로 row-level 배타 점유 → 다중 인스턴스 안전
 * - 만료된 CLAIMED (stale) lease를 PAUSED로 전환 (claim reaper)
 */
@Injectable()
export class InventoryPinOutboxSchedule {
  private readonly logger = new Logger(InventoryPinOutboxSchedule.name);
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly sendService: InventoryPinSendService,
  ) {}

  /**
   * PENDING outbox rows 중 due_at이 현재 이하인 건을 최대 20건 가져와 순차 처리.
   * QueryRunner 트랜잭션에서 SKIP LOCKED → CLAIMED CAS 후 커밋하여 잠금을 유지한다.
   */
  @Cron('10,40 * * * * *')
  async handleOutboxSweep(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const batchSize = Number(process.env.PIN_INVENTORY_OUTBOX_BATCH_SIZE ?? 20);

      // 1단계: 트랜잭션에서 SELECT FOR UPDATE SKIP LOCKED → CAS CLAIMED → commit
      const claimedIds: number[] = [];
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        const rows: { order_delivery_id: number }[] = await queryRunner.query(
          `SELECT \`order_delivery_id\`
           FROM \`inventory_pin_email_outbox\`
           WHERE \`state\` = 'PENDING' AND \`due_at\` <= NOW(6)
           ORDER BY \`due_at\` ASC
           LIMIT ?
           FOR UPDATE SKIP LOCKED`,
          [batchSize],
        );

        if (rows.length > 0) {
          const ids = rows.map(r => r.order_delivery_id);
          await queryRunner.query(
            `UPDATE \`inventory_pin_email_outbox\`
             SET \`state\` = 'CLAIMED',
                 \`lease_until\` = DATE_ADD(NOW(6), INTERVAL ? SECOND)
             WHERE \`order_delivery_id\` IN (${ids.map(() => '?').join(',')})
               AND \`state\` = 'PENDING'`,
            [Number(process.env.PIN_INVENTORY_EMAIL_CLAIM_TTL_SECONDS ?? 300), ...ids],
          );
          claimedIds.push(...ids);
        }

        await queryRunner.commitTransaction();
      } catch (claimErr) {
        await queryRunner.rollbackTransaction();
        throw claimErr;
      } finally {
        await queryRunner.release();
      }

      if (claimedIds.length === 0) {
        return;
      }

      this.logger.log(`[PIN_OUTBOX] sweep: ${claimedIds.length} rows claimed`);

      // 2단계: 잠금 해제 후 순차 처리 (processOutbox가 내부 트랜잭션 사용)
      for (const deliveryId of claimedIds) {
        try {
          await this.sendService.processOutbox(deliveryId);
        } catch (err) {
          // processOutbox 내부에서 이미 UNKNOWN/PAUSED 전환함. 여기선 로그만.
          this.logger.error(
            `[PIN_OUTBOX] processOutbox failed for delivery=${deliveryId}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`[PIN_OUTBOX] sweep error: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Stale claim reaper: lease_until이 지난 CLAIMED outbox를 PAUSED로 강제 전환.
   * 프로세스 장애로 남은 CLAIMED가 영구 고착되는 것을 방지.
   *
   * 잠금 순서: delivery → attempt → outbox (전역 규약).
   * Non-locking scan으로 후보 ID를 수집한 뒤, 전역 순서대로
   * CAS UPDATE를 발행하여 deadlock을 방지한다.
   */
  @Cron('40 */5 * * * *')
  async handleStaleClaims(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      // 1. Non-locking scan: stale 후보 ID 수집 (잠금 없음)
      const staleRows: { order_delivery_id: number }[] = await queryRunner.query(
        `SELECT \`order_delivery_id\`
         FROM \`inventory_pin_email_outbox\`
         WHERE \`state\` = 'CLAIMED'
           AND \`lease_until\` < NOW(6)`,
      );

      if (staleRows.length === 0) {
        await queryRunner.commitTransaction();
        return;
      }

      const staleIds = staleRows.map(r => r.order_delivery_id);
      const placeholders = staleIds.map(() => '?').join(',');

      // 2. Lock delivery first (전역 잠금 순서 1번)
      await queryRunner.query(
        `SELECT \`id\` FROM \`order_delivery\`
         WHERE \`id\` IN (${placeholders})
         FOR UPDATE`,
        staleIds,
      );

      // 3. Lock + update attempt (전역 잠금 순서 2번)
      await queryRunner.query(
        `UPDATE \`inventory_pin_email_attempt\`
         SET \`status\` = 'UNKNOWN',
             \`completed_at\` = NOW(6),
             \`error_code\` = 'STALE_CLAIM_REAPED'
         WHERE \`order_delivery_id\` IN (${placeholders})
           AND \`status\` = 'CLAIMED'`,
        staleIds,
      );

      // 4. Lock + update outbox (전역 잠금 순서 3번) — CAS로 staleness 재확인
      await queryRunner.query(
        `UPDATE \`inventory_pin_email_outbox\`
         SET \`state\` = 'PAUSED',
             \`last_error_code\` = 'STALE_CLAIM_REAPED',
             \`owner_token\` = NULL
         WHERE \`order_delivery_id\` IN (${placeholders})
           AND \`state\` = 'CLAIMED'
           AND \`lease_until\` < NOW(6)`,
        staleIds,
      );

      // 5. delivery fulfillment 상태 전환 (이미 잠금 보유)
      await queryRunner.query(
        `UPDATE \`order_delivery\`
         SET \`direct_pin_fulfillment_status\` = 'UNKNOWN'
         WHERE \`id\` IN (${placeholders})
           AND \`direct_pin_fulfillment_status\` = 'SENDING'`,
        staleIds,
      );

      await queryRunner.commitTransaction();

      this.logger.warn(`[PIN_OUTBOX] stale claim reaper: ${staleIds.length} rows → PAUSED (STALE_CLAIM_REAPED)`);
    } catch (err) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`[PIN_OUTBOX] stale claim reaper error: ${err instanceof Error ? err.message : err}`);
    } finally {
      await queryRunner.release();
    }
  }
}