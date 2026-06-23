import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, Like } from 'typeorm';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { UserEntity } from '../../entity/user.entity';
import { WalletResourceType } from '../interface/wallet-resource-type';

/** wallet_transaction.type — 레거시 동기화가 사용하는 정규 타입(기존 wallet_transaction 타입 체계). */
export type LegacyWalletCreditSyncType =
  | 'SETTLE_RELEASE'
  | 'SETTLE_UNDO'
  | 'FAIL_REFUND'
  | 'RESEND_DEDUCT'
  | 'DISCARD_REFUND';

/**
 * 레거시(allocation 없는 = 컷오버 이전) 주문의 외상(여신) 변동을 wallet_account 에 동기화한다.
 *
 * 배경/문제:
 *   컷오버 backfill(20260521) 은 `wallet_account.credit_used_amount = Σ user.all_settle_amount`
 *   로 레거시 외상까지 지갑 seed 에 담았다. 그러나 레거시 주문(order_payment_allocation 없음)의
 *   정산확정/정산해제/실패환불/재발송역환불/폐기복구는 wallet-managed 분기를 타지 않고
 *   `user.all_settle_amount` 만 갱신한다 → 지갑 credit_used 가 seed 값에 멈춰 영구 드리프트.
 *   분배계산/발송확정은 지갑 credit_used 를 읽으므로 신용초과 오판정이 발생한다.
 *
 * 해결(이 서비스):
 *   레거시 분기에서 `all_settle_amount ±= X` 를 수행할 때 같은 manager/TX 로 호출하여
 *   동일 금액을 settlement_code wallet 의 credit_used_amount 에 반영하고 감사 트랜잭션을 남긴다.
 *   불변식 `wallet.credit_used == Σ(company user.all_settle_amount)` 를 실시간 유지한다.
 *
 * 사용:
 *   - 호출자가 이미 `user.all_settle_amount` 를 갱신한 직후, 동일 manager 로 호출한다(원자성).
 *   - delta < 0: 외상 감소(정산확정 / 실패환불 / 폐기복구) → credit_used 차감.
 *   - delta > 0: 외상 증가(정산해제 / 재발송 역환불) → credit_used 가산.
 *   - wallet-managed(allocation 존재) 주문에는 호출하지 않는다(이미 wallet 경로가 처리).
 *
 * 멱등:
 *   호출자 분기마다 진입 전 멱등 게이트(정산 atomic UPDATE / refund ledger)가 있어 1회만 실행된다.
 *   wallet_transaction.idempotency_key 는 (keyBase + 동일 prefix tx 수) 로 이벤트별 UNIQUE 를 보장한다
 *   (wallet_account FOR UPDATE 로 직렬화되어 race-free).
 */
@Injectable()
export class LegacyWalletCreditSyncService {
  private readonly logger = new Logger(LegacyWalletCreditSyncService.name);

  async syncCredit(
    manager: EntityManager,
    params: {
      /** 과금 대상 user (대행주문이면 clientUserId). settlement_code → wallet 조회 키. */
      billingUserId: number;
      orderId: number;
      /** 발송 단위 이벤트(환불/폐기)면 지정. 정산확정/해제는 null. */
      orderDeliveryId?: number | null;
      /** 부호 있는 변동액. 음수=외상 감소(차감), 양수=외상 증가(가산). */
      delta: number;
      /** wallet_transaction.type — 정규 타입 사용. */
      type: LegacyWalletCreditSyncType;
      memo: string;
    },
  ): Promise<void> {
    if (params.delta === 0) return;

    const user = await manager.getRepository(UserEntity).findOne({
      where: { id: params.billingUserId },
      select: ['id', 'settlementCode'],
    });
    if (!user?.settlementCode) {
      throw new NotFoundException(
        `legacy wallet sync: settlement_code missing for user id=${params.billingUserId} (orderId=${params.orderId})`,
      );
    }

    // wallet_account FOR UPDATE — 동일 settlement_code 변동을 직렬화(멱등 seq race-free).
    const wallet = await manager
      .getRepository(WalletAccountEntity)
      .createQueryBuilder('w')
      .setLock('pessimistic_write')
      .where('w.ownerType = :t', { t: 'SETTLEMENT_CODE' })
      .andWhere('w.ownerId = :c', { c: user.settlementCode })
      .getOne();
    if (!wallet) {
      throw new NotFoundException(
        `legacy wallet sync: wallet_account not found for settlement_code=${user.settlementCode} (orderId=${params.orderId})`,
      );
    }

    const before = wallet.creditUsedAmount;
    const newCreditUsed = before + params.delta;
    const clamped = Math.max(0, newCreditUsed);
    const applied = clamped - before;
    if (newCreditUsed < 0) {
      // 회사 단위 불변식상 음수는 비정상(상류 외상 정합성 깨짐). 0 으로 바닥 처리하되 운영 점검 신호.
      this.logger.error(
        `legacy wallet sync: credit_used would go negative — clamped to 0. ` +
          `settlementCode=${user.settlementCode} before=${before} requestedDelta=${params.delta} ` +
          `appliedDelta=${applied} orderId=${params.orderId} deliveryId=${params.orderDeliveryId ?? 'null'} type=${params.type}`,
      );
    }
    wallet.creditUsedAmount = clamped;
    await manager.save(WalletAccountEntity, wallet);

    const keyBase =
      params.orderDeliveryId != null
        ? `legacy_${params.type.toLowerCase()}:${params.orderId}:${params.orderDeliveryId}:credit`
        : `legacy_${params.type.toLowerCase()}:${params.orderId}:credit`;
    const seq = await manager
      .getRepository(WalletTransactionEntity)
      .count({ where: { idempotencyKey: Like(`${keyBase}:%`) } });

    await manager.save(WalletTransactionEntity, {
      walletAccountId: String(wallet.id),
      orderId: params.orderId,
      orderDeliveryId: params.orderDeliveryId ?? null,
      type: params.type,
      resourceType: WalletResourceType.CREDIT,
      amount: applied,
      balanceAfter: wallet.creditUsedAmount,
      memo: params.memo.slice(0, 500),
      idempotencyKey: `${keyBase}:${seq}`,
    });
  }
}
