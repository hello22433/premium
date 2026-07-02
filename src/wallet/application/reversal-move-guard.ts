import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OrderEntity } from '../../entity/order.entity';
import { UserEntity } from '../../entity/user.entity';
import { getBillingUserId } from '../../order/domain/order.billing-user.helper';

/**
 * H1 — reversal-after-move 차단 가드 (plan Rev6 H1).
 *
 * settlement_code 이동 후 과거 주문의 역처리(정산해제/undo, CS 폐기환불/실패환불, 재발송 차감)를 시도하면,
 * wallet 역처리는 원 allocation wallet(코드 A)을 정확히 되돌리지만 legacy all_settle mirror 는 per-USER 라
 * 현재 코드(코드 B)로 귀속돼 wallet.credit_used == Σ(코드 사용자).all_settle 불변식이 두 코드로 쪼개진다.
 *
 * 따라서 allocation 이 가리키는 wallet 의 owner_id(= 주문 당시 정산코드)가 과금 대상 user 의 CURRENT
 * settlement_code 와 다르면 역처리를 차단한다. 운영자는 계정을 원 코드로 되돌린 뒤 처리해야 한다.
 *
 * @param manager       역처리 트랜잭션의 EntityManager (동일 TX 안에서 조회).
 * @param order         과금 대상 판정용 order (userId / clientUserId).
 * @param walletOwnerId allocation.walletAccountId 가 가리키는 wallet_account.owner_id (= 잠근 wallet 의 ownerId).
 */
export async function assertAllocationCodeNotMoved(
  manager: EntityManager,
  order: Pick<OrderEntity, 'userId' | 'clientUserId'>,
  walletOwnerId: string,
): Promise<void> {
  const billingUserId = getBillingUserId(order);
  const user = await manager.getRepository(UserEntity).findOne({
    where: { id: billingUserId },
    select: ['id', 'settlementCode'],
  });
  const currentCode = (user?.settlementCode ?? '').toString();
  const originalCode = (walletOwnerId ?? '').toString();

  if (currentCode !== originalCode) {
    throw new BadRequestException(
      `정산코드가 변경된 계정의 주문입니다. 이 역처리(정산해제/환불/재발송)를 진행하려면 계정을 ` +
        `주문의 원래 정산코드('${originalCode}')로 되돌린 뒤 처리하세요. (현재 코드='${currentCode || '(미배정)'}')`,
    );
  }
}
