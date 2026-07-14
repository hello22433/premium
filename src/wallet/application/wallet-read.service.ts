import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { PointGrantEntity } from '../../entity/point.grant.entity';
import { OrderPaymentAllocationEntity } from '../../entity/order.payment.allocation.entity';
import { UserEntity } from '../../entity/user.entity';
import { UserCompanyEntity } from '../../entity/user.company.entity';

export type WalletStatus = 'ACTIVE' | 'MISSING';

export interface SettlementCodeAssignedUser {
  userId: number;
  personName: string;
}

export interface SettlementCodeSnapshot {
  settlementCode: string;
  walletAccountId: string | null;
  walletStatus: WalletStatus;
  depositBalance: number;
  creditLimit: number;
  creditUsedAmount: number;
  creditExcessAmount: number;
  pointTotalRemaining: number;
  settleCondition: 'PRE_PAYMENT' | 'POST_PAYMENT' | null;
  settleMethod: 'CARD' | 'CASH' | null;
  assignedUsers: SettlementCodeAssignedUser[];
}

export interface SettlementCodeSnapshotResult {
  companyId: number;
  companyName: string;
  settlementCodes: SettlementCodeSnapshot[];
}

export interface SettlementCodeAssignedAccount {
  userId: number;
  personName: string;
  companyId: number | null;
  companyName: string | null;
}

export interface SettlementCodeDetail {
  settlementCode: string;
  walletAccountId: string | null;
  walletStatus: WalletStatus;
  depositBalance: number;
  creditLimit: number;
  creditUsedAmount: number;
  creditExcessAmount: number;
  pointTotalRemaining: number;
  settleCondition: 'PRE_PAYMENT' | 'POST_PAYMENT' | null;
  settleMethod: 'CARD' | 'CASH' | null;
  /** 이 정산코드에 배정된 전체 계정 (회사 걸침 가능 — N:M). */
  assignedAccounts: SettlementCodeAssignedAccount[];
}

export interface SettlementCodeUsage {
  settlementCode: string;
  walletAccountId: string | null;
  walletStatus: WalletStatus;
  /** = Σ allocation.payableSettlementAmount. legacy "정산확정액"과 다른 지표(합산 금지). */
  walletPaidAmount: number;
  depositUsedAmount: number;
  creditUsedAmount: number;
  creditExcessAmount: number;
  pointUsedAmount: number;
  orderCount: number;
}

export interface SettlementCodeUsageResult {
  companyId: number;
  companyName: string;
  period: { from: string; to: string };
  /** 기간 기준 = allocation.createdAt(= wallet 차감/발송확정 시점). 주문 등록일/실발송일과 다른 축. */
  periodBasis: 'WALLET_DEDUCTED_AT';
  settlementCodes: SettlementCodeUsage[];
}

/**
 * settlement_code(정산코드) 단위 정산 조회 read service. (PR4)
 *
 * View S = getSettlementCodeSnapshot: 정산코드별 현재 wallet 잔액/포인트 잔액.
 * View R = getSettlementCodeUsage: 정산코드별 기간 wallet 결제액(allocation 집계, 발송확정 시점 기준).
 *
 * 정합 책임 일원화 위해 wallet_account / point_grant / order_payment_allocation 조회를 본 service 에 모음.
 * walletPaidAmount(allocation)와 legacy settle "정산확정액"(SUM(allSettleAmount))은 별 지표 — 합산 금지.
 */
@Injectable()
export class WalletReadService {
  constructor(
    @InjectRepository(WalletAccountEntity)
    private readonly walletRepository: Repository<WalletAccountEntity>,
    @InjectRepository(PointGrantEntity)
    private readonly pointGrantRepository: Repository<PointGrantEntity>,
    @InjectRepository(OrderPaymentAllocationEntity)
    private readonly allocationRepository: Repository<OrderPaymentAllocationEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(UserCompanyEntity)
    private readonly userCompanyRepository: Repository<UserCompanyEntity>,
  ) {}

  async getSettlementCodeSnapshot(companyId: number): Promise<SettlementCodeSnapshotResult> {
    const companyName = await this.resolveCompanyName(companyId);
    const codes = await this.distinctSettlementCodes(companyId);

    const settlementCodes: SettlementCodeSnapshot[] = [];
    for (const settlementCode of codes) {
      const wallet = await this.findWalletBySettlementCode(settlementCode);
      const assignedUsers = await this.assignedUsers(companyId, settlementCode);

      if (!wallet) {
        settlementCodes.push({
          settlementCode,
          walletAccountId: null,
          walletStatus: 'MISSING',
          depositBalance: 0,
          creditLimit: 0,
          creditUsedAmount: 0,
          creditExcessAmount: 0,
          pointTotalRemaining: 0,
          settleCondition: null,
          settleMethod: null,
          assignedUsers,
        });
        continue;
      }

      settlementCodes.push({
        settlementCode,
        walletAccountId: wallet.id,
        walletStatus: 'ACTIVE',
        depositBalance: wallet.depositBalance,
        creditLimit: wallet.creditLimit,
        creditUsedAmount: wallet.creditUsedAmount,
        creditExcessAmount: wallet.creditExcessAmount,
        pointTotalRemaining: await this.pointTotalRemaining(wallet.id),
        settleCondition: wallet.settleCondition,
        settleMethod: wallet.settleMethod,
        assignedUsers,
      });
    }

    return { companyId, companyName, settlementCodes };
  }

  /**
   * settlement_code 키 단위 상세 조회 (회사 스코프 아님 — N:M 대응).
   * 코드에 배정된 전체 계정을 회사 걸침 포함해 반환한다. 코드 자체가 존재하지 않으면 NotFound.
   */
  async getSettlementCodeDetail(settlementCode: string): Promise<SettlementCodeDetail> {
    if (!settlementCode || settlementCode.trim() === '') {
      throw new BadRequestException('settlementCode 는 필수입니다.');
    }
    const wallet = await this.findWalletBySettlementCode(settlementCode);
    const rows = await this.userRepository
      .createQueryBuilder('u')
      .leftJoin(UserCompanyEntity, 'c', 'c.id = u.companyId')
      .select('u.id', 'userId')
      .addSelect('u.personName', 'personName')
      .addSelect('u.companyId', 'companyId')
      .addSelect('c.businessName', 'companyName')
      .where('u.settlementCode = :code', { code: settlementCode })
      .orderBy('u.companyId', 'ASC')
      .addOrderBy('u.id', 'ASC')
      .getRawMany<{ userId: number; personName: string; companyId: number | null; companyName: string | null }>();

    if (!wallet && rows.length === 0) {
      throw new NotFoundException(`settlement_code not found: ${settlementCode}`);
    }

    const assignedAccounts: SettlementCodeAssignedAccount[] = rows.map((r) => ({
      userId: Number(r.userId),
      personName: r.personName,
      companyId: r.companyId != null ? Number(r.companyId) : null,
      companyName: r.companyName ?? null,
    }));

    if (!wallet) {
      return {
        settlementCode,
        walletAccountId: null,
        walletStatus: 'MISSING',
        depositBalance: 0,
        creditLimit: 0,
        creditUsedAmount: 0,
        creditExcessAmount: 0,
        pointTotalRemaining: 0,
        settleCondition: null,
        settleMethod: null,
        assignedAccounts,
      };
    }

    return {
      settlementCode,
      walletAccountId: wallet.id,
      walletStatus: 'ACTIVE',
      depositBalance: wallet.depositBalance,
      creditLimit: wallet.creditLimit,
      creditUsedAmount: wallet.creditUsedAmount,
      creditExcessAmount: wallet.creditExcessAmount,
      pointTotalRemaining: await this.pointTotalRemaining(wallet.id),
      settleCondition: wallet.settleCondition,
      settleMethod: wallet.settleMethod,
      assignedAccounts,
    };
  }

  async getSettlementCodeUsage(
    companyId: number,
    from: string,
    to: string,
    includeReleased = false,
  ): Promise<SettlementCodeUsageResult> {
    if (!from || !to) {
      throw new BadRequestException('from, to 는 필수입니다 (YYYY-MM-DD).');
    }
    const companyName = await this.resolveCompanyName(companyId);
    const codes = await this.distinctSettlementCodes(companyId);

    const settlementCodes: SettlementCodeUsage[] = [];
    for (const settlementCode of codes) {
      const wallet = await this.findWalletBySettlementCode(settlementCode);

      if (!wallet) {
        settlementCodes.push({
          settlementCode,
          walletAccountId: null,
          walletStatus: 'MISSING',
          walletPaidAmount: 0,
          depositUsedAmount: 0,
          creditUsedAmount: 0,
          creditExcessAmount: 0,
          pointUsedAmount: 0,
          orderCount: 0,
        });
        continue;
      }

      settlementCodes.push({
        settlementCode,
        walletAccountId: wallet.id,
        walletStatus: 'ACTIVE',
        ...(await this.allocationAggregate(wallet.id, from, to, includeReleased)),
      });
    }

    return {
      companyId,
      companyName,
      period: { from, to },
      periodBasis: 'WALLET_DEDUCTED_AT',
      settlementCodes,
    };
  }

  /** ownerType=SETTLEMENT_CODE 인 wallet 조회. 미존재 시 null. */
  private async findWalletBySettlementCode(settlementCode: string): Promise<WalletAccountEntity | null> {
    return this.walletRepository.findOne({
      where: { ownerType: 'SETTLEMENT_CODE', ownerId: settlementCode },
    });
  }

  private async resolveCompanyName(companyId: number): Promise<string> {
    const company = await this.userCompanyRepository.findOne({
      where: { id: companyId },
      select: ['id', 'businessName'],
    });
    if (!company) {
      throw new NotFoundException(`company not found id=${companyId}`);
    }
    return company.businessName;
  }

  /** 회사 소속 user 의 settlement_code distinct. 빈 문자열(미설정) 제외. */
  private async distinctSettlementCodes(companyId: number): Promise<string[]> {
    const rows = await this.userRepository
      .createQueryBuilder('u')
      .select('DISTINCT u.settlementCode', 'settlementCode')
      .where('u.companyId = :companyId', { companyId })
      .andWhere("u.settlementCode != ''")
      .orderBy('u.settlementCode', 'ASC')
      .getRawMany<{ settlementCode: string }>();
    return rows.map((r) => r.settlementCode);
  }

  private async assignedUsers(companyId: number, settlementCode: string): Promise<SettlementCodeAssignedUser[]> {
    const users = await this.userRepository.find({
      where: { companyId, settlementCode },
      select: ['id', 'personName'],
      order: { id: 'ASC' },
    });
    return users.map((u) => ({ userId: u.id, personName: u.personName }));
  }

  /** 사용 가능 포인트 잔액 합 — 만료/비활성/소진 제외. */
  private async pointTotalRemaining(walletAccountId: string): Promise<number> {
    const row = await this.pointGrantRepository
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.remainingAmount), 0)', 'total')
      .where('p.walletAccountId = :walletAccountId', { walletAccountId })
      .andWhere('p.active = 1')
      .andWhere('p.remainingAmount > 0')
      .andWhere('(p.expiresAt IS NULL OR p.expiresAt > NOW())')
      .getRawOne<{ total: string }>();
    return Number(row?.total ?? 0);
  }

  private async allocationAggregate(
    walletAccountId: string,
    from: string,
    to: string,
    includeReleased: boolean,
  ): Promise<Omit<SettlementCodeUsage, 'settlementCode' | 'walletAccountId' | 'walletStatus'>> {
    const qb = this.allocationRepository
      .createQueryBuilder('a')
      .select('COALESCE(SUM(a.payableSettlementAmount), 0)', 'walletPaidAmount')
      .addSelect('COALESCE(SUM(a.depositUsedAmount), 0)', 'depositUsedAmount')
      .addSelect('COALESCE(SUM(a.creditUsedAmount), 0)', 'creditUsedAmount')
      .addSelect('COALESCE(SUM(a.creditExcessAmount), 0)', 'creditExcessAmount')
      .addSelect('COALESCE(SUM(a.pointUsedAmount), 0)', 'pointUsedAmount')
      .addSelect('COUNT(*)', 'orderCount')
      .where('a.walletAccountId = :walletAccountId', { walletAccountId })
      .andWhere('a.createdAt >= :fromTs', { fromTs: `${from} 00:00:00` })
      .andWhere('a.createdAt <= :toTs', { toTs: `${to} 23:59:59` });
    if (!includeReleased) {
      qb.andWhere('a.releasedAt IS NULL');
    }
    const row = await qb.getRawOne<{
      walletPaidAmount: string;
      depositUsedAmount: string;
      creditUsedAmount: string;
      creditExcessAmount: string;
      pointUsedAmount: string;
      orderCount: string;
    }>();
    return {
      walletPaidAmount: Number(row?.walletPaidAmount ?? 0),
      depositUsedAmount: Number(row?.depositUsedAmount ?? 0),
      creditUsedAmount: Number(row?.creditUsedAmount ?? 0),
      creditExcessAmount: Number(row?.creditExcessAmount ?? 0),
      pointUsedAmount: Number(row?.pointUsedAmount ?? 0),
      orderCount: Number(row?.orderCount ?? 0),
    };
  }
}
