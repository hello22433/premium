import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { UserEntity } from '../../entity/user.entity';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import { PointGrantEntity } from '../../entity/point.grant.entity';

export interface SettlementCodeBucket {
  settlementCode: string;
  walletAccountId: string;
  depositBalance: number;
  creditLimit: number;
  creditUsedAmount: number;
  creditExcessAmount: number;
  pointTotalRemaining: number;
  assignedUsers: Array<{ userId: number; personName: string }>;
}

export interface SettleByCompanyView {
  companyId: number;
  companyName: string;
  settlementCodes: SettlementCodeBucket[];
}

/**
 * PR4 — settlement_code 단위 분리 조회.
 * - 회사 내 user 들의 settlement_code 별 group.
 * - 각 settlement_code 의 wallet_account 잔액/한도/포인트 합산.
 */
@Injectable()
export class SettleAdminReadService {
  constructor(
    @InjectRepository(UserCompanyEntity) private readonly companyRepo: Repository<UserCompanyEntity>,
    @InjectRepository(UserEntity) private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(WalletAccountEntity) private readonly walletRepo: Repository<WalletAccountEntity>,
    @InjectRepository(PointGrantEntity) private readonly grantRepo: Repository<PointGrantEntity>,
  ) {}

  async getByCompany(companyId: number): Promise<SettleByCompanyView> {
    const company = await this.companyRepo.findOne({ where: { id: companyId } });
    if (!company) throw new NotFoundException(`company not found id=${companyId}`);

    const users = await this.userRepo.find({
      where: { companyId },
      select: ['id', 'personName', 'settlementCode'],
    });

    const groupedBySettlementCode = new Map<string, Array<{ userId: number; personName: string }>>();
    for (const u of users) {
      const code = u.settlementCode || `company-${companyId}`;
      if (!groupedBySettlementCode.has(code)) groupedBySettlementCode.set(code, []);
      groupedBySettlementCode.get(code)!.push({ userId: u.id, personName: u.personName });
    }

    const buckets: SettlementCodeBucket[] = [];
    for (const [code, assignedUsers] of groupedBySettlementCode.entries()) {
      const wallet = await this.walletRepo.findOne({
        where: { ownerType: 'SETTLEMENT_CODE', ownerId: code },
      });
      if (!wallet) {
        buckets.push({
          settlementCode: code,
          walletAccountId: '',
          depositBalance: 0,
          creditLimit: 0,
          creditUsedAmount: 0,
          creditExcessAmount: 0,
          pointTotalRemaining: 0,
          assignedUsers,
        });
        continue;
      }
      const grants = await this.grantRepo.find({ where: { walletAccountId: wallet.id, active: 1 } });
      const pointTotal = grants.reduce((s, g) => s + g.remainingAmount, 0);
      buckets.push({
        settlementCode: code,
        walletAccountId: wallet.id,
        depositBalance: wallet.depositBalance,
        creditLimit: wallet.creditLimit,
        creditUsedAmount: wallet.creditUsedAmount,
        creditExcessAmount: wallet.creditExcessAmount,
        pointTotalRemaining: pointTotal,
        assignedUsers,
      });
    }

    return {
      companyId,
      companyName: company.businessName,
      settlementCodes: buckets,
    };
  }
}
