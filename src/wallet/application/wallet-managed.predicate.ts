import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';

/**
 * 주문 단위 wallet-managed 여부 predicate.
 *
 * Cutover Bundle (plan v2.1) 핵심: 후속 hook (refundForFail / settle / settle_undo / CS 폐기 /
 * 재발송 / 외부 API) 의 wallet path 여부는 `WALLET_PR{N}_*_MODE` flag 가 아니라 이 predicate 로 결정.
 *
 * Routing 우선순위 (Round 5 결정):
 *   allocation 존재 AND released_at IS NULL → wallet path
 *   외 → legacy path
 *
 * 즉 PR3/PR4 flag 가 legacy 라도 wallet-managed 주문은 wallet path 진입. PR3/PR4 hook 코드는
 * prod 에 반드시 배포돼야 함 (Cutover Bundle activation gate 의 직접 근거).
 *
 * ===== Lock 순서 표준 (Bundle 전체 invariant) =====
 *
 *   1. wallet_account FOR UPDATE         ← 잔액/한도 갱신 직전 (§3 plan)
 *   2. order_payment_allocation FOR UPDATE ← allocation 또는 ledger 갱신 직전
 *   3. wallet_transaction INSERT          ← idempotency_key UNIQUE 가 동시성 직렬화
 *
 * 역순(allocation → wallet_account)은 PR3 settle vs PR4 CS 사이 deadlock 위험 → 금지.
 * BI-002 deadlock regression spec 으로 회귀 차단.
 *
 * @see plan v2.1 §3 / Cross-PR Concerns "Lock order standardization"
 * @see .omc/specs/deep-interview-wallet-pr2-to-pr5-hook-strategy.md Round 5
 */
@Injectable()
export class WalletManagedPredicate {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * 해당 주문이 wallet-managed 인지 검사. EntityManager 인자 미전달 시 dataSource.manager 사용.
   *
   * @param orderId order.id
   * @param manager 트랜잭션 매니저 (선택). same-tx 안에서 호출 시 전달.
   * @returns true = wallet path 분기 / false = legacy path 분기
   */
  async isWalletManaged(orderId: number, manager?: EntityManager): Promise<boolean> {
    const repo = (manager ?? this.dataSource.manager).getRepository(OrderPaymentAllocationEntity);
    const row = await repo
      .createQueryBuilder('a')
      .select('1', 'exists_flag')
      .where('a.order_id = :orderId', { orderId })
      .andWhere('a.released_at IS NULL')
      .limit(1)
      .getRawOne<{ exists_flag: number }>();
    return row != null;
  }
}
