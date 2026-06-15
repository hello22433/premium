import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrderDeliveryRefundEntity } from '../../entity/order.delivery.refund.entity';
import { SsgRecoveryResult } from '../interface/ssg.recovery.result';
import { SsgRecoveryService } from './ssg-recovery.service';

/**
 * sweep 후보 1건. migration 격리 + lease 게이트로 자동 수렴시킬 DEFERRED SSG 복구 backlog.
 */
interface SsgSweepCandidate {
  orderDeliveryId: number;
  ssgEventId: number;
  orderId: number;
  refundAmount: number;
}

/**
 * SSG 행사 잔액 복구 sweep.
 * docs/plans/2026-06-12-external-api-wallet-integration.md B-7.
 *
 * 후보: ssg_balance_settled=false 이고 lease 미보유/만료인 SSG 환불 ledger 중
 *       refunded_at >= migrationAt (시간 격리, B-7 기본정책 — 그 이전 backlog 는 제외).
 * 각 후보를 recoverWithLease 로 처리해 sweep 과 실시간이 같은 멱등 기반(B-6)을 공유한다.
 *
 * refundAmount = order.sendAmount(스냅샷), product.price 아님.
 */
@Injectable()
export class SsgRecoverySweepService {
  private readonly logger = new Logger(SsgRecoverySweepService.name);

  /** 한 회 sweep 처리 후보 상한. */
  static readonly SWEEP_LIMIT = 100;

  constructor(
    @InjectRepository(OrderDeliveryRefundEntity)
    private readonly refundRepository: Repository<OrderDeliveryRefundEntity>,
    private readonly ssgRecoveryService: SsgRecoveryService,
  ) {}

  /**
   * migrationAt 이후 backlog 만 대상으로 한 회 sweep.
   * @returns 처리(claim 소유 후 resolver 호출) 시도한 후보 수 통계.
   */
  async sweepOnce(): Promise<{ candidates: number; restored: number; deferred: number; skipped: number }> {
    const migrationAt = this.resolveMigrationAt();
    if (migrationAt === null) {
      // cutoff 미설정/파싱실패 → sweep 중단. new Date() fallback 은 신규 ledger 까지 영구 제외(영구 no-op)하므로 금지.
      this.logger.error(
        '[SSG_SWEEP] SSG_SWEEP_MIGRATION_AT 미설정/파싱실패 — sweep 중단. ' +
          '고정 ISO timestamp 환경변수 설정 필요 (미설정 시 backlog 자동 수렴 안 됨).',
      );
      return { candidates: 0, restored: 0, deferred: 0, skipped: 0 };
    }
    const candidates = await this.findCandidates(migrationAt);

    let restored = 0;
    let deferred = 0;
    let skipped = 0;

    for (const c of candidates) {
      try {
        const result = await this.ssgRecoveryService.recoverWithLease(
          c.orderDeliveryId,
          c.ssgEventId,
          c.orderId,
          c.refundAmount,
        );
        if (result === SsgRecoveryResult.RESTORED || result === SsgRecoveryResult.SKIPPED_CONFIRMED) {
          restored++;
        } else if (result === SsgRecoveryResult.DEFERRED) {
          deferred++;
        } else {
          // SKIPPED_NO_CLAIM: 다른 actor 가 lease 보유 중 — 다음 주기에 재시도됨.
          skipped++;
        }
      } catch (e) {
        // recoverWithLease 자체는 resolver 예외를 흡수하지만, claim UPDATE 등 인프라 예외는
        // 한 후보 실패가 sweep 전체를 막지 않도록 흡수한다 (다음 주기 재시도).
        this.logger.error(
          `[SSG_SWEEP] 후보 처리 예외 — skip. orderDeliveryId=${c.orderDeliveryId}, error: ${e instanceof Error ? e.message : e}`,
        );
        skipped++;
      }
    }

    if (candidates.length) {
      this.logger.log(
        `[SSG_SWEEP] 완료 — candidates=${candidates.length}, restored=${restored}, deferred=${deferred}, skipped=${skipped}`,
      );
    }
    return { candidates: candidates.length, restored, deferred, skipped };
  }

  /**
   * sweep 후보 조회. SSG 주문 + lease 미보유/만료 + 시간 격리.
   * refundAmount 는 order.sendAmount 스냅샷.
   */
  private async findCandidates(migrationAt: Date): Promise<SsgSweepCandidate[]> {
    const rows = await this.refundRepository
      .createQueryBuilder('r')
      .innerJoin('order_delivery', 'd', 'd.id = r.order_delivery_id AND d.ssg_event_id IS NOT NULL')
      .innerJoin('order_product_mapping', 'opm', 'opm.id = d.order_product_mapping_id')
      .innerJoin('order', 'o', "o.id = opm.order_id AND o.type = 'SSG'")
      .select('r.order_delivery_id', 'orderDeliveryId')
      .addSelect('d.ssg_event_id', 'ssgEventId')
      .addSelect('o.id', 'orderId')
      .addSelect('o.send_amount', 'refundAmount')
      .where('r.ssg_balance_settled = false')
      .andWhere('(r.ssg_recover_lease_until IS NULL OR r.ssg_recover_lease_until < NOW(6))')
      .andWhere('r.refunded_at >= :migrationAt', { migrationAt })
      .orderBy('r.id', 'ASC')
      .limit(SsgRecoverySweepService.SWEEP_LIMIT)
      .getRawMany();

    return rows.map((row) => ({
      orderDeliveryId: Number(row.orderDeliveryId),
      ssgEventId: Number(row.ssgEventId),
      orderId: Number(row.orderId),
      refundAmount: Number(row.refundAmount),
    }));
  }

  /**
   * SSG_SWEEP_MIGRATION_AT(고정 ISO 문자열) 이전 backlog 는 sweep 제외 (시간 격리).
   *
   * 미설정/파싱실패 시 null 반환 → caller(sweepOnce)가 sweep 중단.
   * new Date() fallback 을 쓰면 매 실행 cutoff 가 "지금"으로 밀려 신규 ledger 까지 영구 제외(sweep 영구 no-op)되므로,
   * 반드시 운영에서 고정 timestamp 를 설정해야 한다.
   */
  private resolveMigrationAt(): Date | null {
    const raw = process.env.SSG_SWEEP_MIGRATION_AT?.trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      this.logger.error(`[SSG_SWEEP] SSG_SWEEP_MIGRATION_AT 파싱 실패('${raw}') — sweep 중단.`);
      return null;
    }
    return parsed;
  }
}
