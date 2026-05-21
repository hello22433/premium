import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { UserEntity } from '../../entity/user.entity';

/**
 * settlement_code 단위 wallet 조회.
 * - 모든 user 는 default 로 `company-${companyId}` 공유 code 보유 (PR1a backfill).
 * - 운영자가 user.settlement_code 임의 변경 시 다른 wallet 조회 (PR3 spec).
 */
@Injectable()
export class WalletAccountResolverService {
  constructor(
    @InjectRepository(WalletAccountEntity)
    private readonly walletRepository: Repository<WalletAccountEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  async resolveBySettlementCode(code: string): Promise<WalletAccountEntity> {
    const wallet = await this.walletRepository.findOne({
      where: { ownerType: 'SETTLEMENT_CODE', ownerId: code },
    });
    if (!wallet) {
      throw new NotFoundException(`wallet_account not found for settlement_code=${code}`);
    }
    return wallet;
  }

  async resolveByUserId(userId: number): Promise<WalletAccountEntity> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: ['id', 'settlementCode'],
    });
    if (!user) {
      throw new NotFoundException(`user not found id=${userId}`);
    }
    if (!user.settlementCode) {
      throw new NotFoundException(`settlement_code missing for user id=${userId}`);
    }
    return this.resolveBySettlementCode(user.settlementCode);
  }
}
