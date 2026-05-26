import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { UserEntity } from '../../entity/user.entity';
import { getBillingUserId } from '../../order/domain/order.billing-user.helper';

/**
 * settlement_code 단위 wallet 조회.
 * - 모든 user 는 default 로 `company-${companyId}` 공유 code 보유 (PR1a backfill).
 * - 운영자가 user.settlement_code 임의 변경 시 다른 wallet 조회 (PR3 spec).
 *
 * Cutover Bundle PR2-001: resolveForOrder 가 billing user 단위 wallet 을 반환.
 */
@Injectable()
export class WalletAccountResolverService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(WalletAccountEntity)
    private readonly walletRepository: Repository<WalletAccountEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  async resolveBySettlementCode(code: string, manager?: EntityManager): Promise<WalletAccountEntity> {
    const repo = manager ? manager.getRepository(WalletAccountEntity) : this.walletRepository;
    const wallet = await repo.findOne({
      where: { ownerType: 'SETTLEMENT_CODE', ownerId: code },
    });
    if (!wallet) {
      throw new NotFoundException(`wallet_account not found for settlement_code=${code}`);
    }
    return wallet;
  }

  async resolveByUserId(userId: number, manager?: EntityManager): Promise<WalletAccountEntity> {
    const userRepo = manager ? manager.getRepository(UserEntity) : this.userRepository;
    const user = await userRepo.findOne({
      where: { id: userId },
      select: ['id', 'settlementCode'],
    });
    if (!user) {
      throw new NotFoundException(`user not found id=${userId}`);
    }
    if (!user.settlementCode) {
      throw new NotFoundException(`settlement_code missing for user id=${userId}`);
    }
    return this.resolveBySettlementCode(user.settlementCode, manager);
  }

  /**
   * 주문의 wallet_account 조회. billing user (대행주문 호환 — `clientUserId ?? userId`) 의
   * settlement_code 로 wallet 조회. PR2 deliveryConfirmed / refundForFail hook 진입점.
   *
   * @param order order.userId + order.clientUserId 만 있으면 동작 (Partial Order)
   * @param manager 같은 트랜잭션에서 호출 시 EntityManager 전달
   */
  async resolveForOrder(
    order: Pick<{ userId: number; clientUserId: number | null }, 'userId' | 'clientUserId'>,
    manager?: EntityManager,
  ): Promise<WalletAccountEntity> {
    return this.resolveByUserId(getBillingUserId(order), manager);
  }
}
