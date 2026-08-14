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
  cardSurchargeApplied: boolean;
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

export type SettlementCodeRenameBlockReason =
  | 'CROSS_COMPANY_REFERENCE'
  | 'COMPANYLESS_REFERENCE'
  | 'NOT_OWNER_COMPANY'
  | 'OWNER_COMPANY_MISSING'
  | 'WALLET_MISSING';

export interface SettlementCodeDetail {
  settlementCode: string;
  walletAccountId: string | null;
  walletStatus: WalletStatus;
  ownerCompanyId: number | null;
  renameAllowed: boolean;
  renameBlockReason: SettlementCodeRenameBlockReason | null;
  depositBalance: number;
  creditLimit: number;
  creditUsedAmount: number;
  creditExcessAmount: number;
  pointTotalRemaining: number;
  settleCondition: 'PRE_PAYMENT' | 'POST_PAYMENT' | null;
  settleMethod: 'CARD' | 'CASH' | null;
  cardSurchargeApplied: boolean;
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

export interface SettlementCodeSearchFilter {
  /** 홈(발급) 회사 필터. 생략 시 전 회사 검색(회사 선택 강제 완화). */
  companyId?: number;
  settleCondition?: 'PRE_PAYMENT' | 'POST_PAYMENT';
  settleMethod?: 'CARD' | 'CASH';
  depositMin?: number;
  depositMax?: number;
  creditLimitMin?: number;
  creditLimitMax?: number;
  /** 정산코드 부분검색(ownerId LIKE). */
  codeQuery?: string;
  /** 커서 = 직전 페이지 마지막 walletAccountId. */
  cursor?: string;
  limit?: number;
}

export interface SettlementCodeSearchItem {
  settlementCode: string;
  walletAccountId: string;
  ownerCompanyId: number | null;
  ownerCompanyName: string | null;
  walletStatus: 'ACTIVE';
  settleCondition: 'PRE_PAYMENT' | 'POST_PAYMENT';
  settleMethod: 'CARD' | 'CASH';
  depositBalance: number;
  creditLimit: number;
  creditUsedAmount: number;
  creditExcessAmount: number;
  /** 이 코드에 배정된 계정 수(회사 걸침 포함 — N:M). 0이어도 노출(P1). */
  assignedUserCount: number;
}

export interface SettlementCodeSearchResult {
  items: SettlementCodeSearchItem[];
  /** 다음 페이지 커서. 없으면 null(마지막 페이지). */
  nextCursor: string | null;
}

const SEARCH_LIMIT_DEFAULT = 50;
const SEARCH_LIMIT_MAX = 200;

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
    const codes = await this.companySettlementCodes(companyId);

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
          cardSurchargeApplied: true,
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
        cardSurchargeApplied: wallet.cardSurchargeApplied,
        assignedUsers,
      });
    }

    return { companyId, companyName, settlementCodes };
  }

  /**
   * 정산코드 검색 (필터 + 커서 페이지네이션, §3 P2). 회사 선택 강제 완화 — `companyId` 생략 시 전 회사 검색.
   * wallet_account(ACTIVE) 기준 **단일 쿼리**(N+1 없음). `assignedUserCount` 는 상관 서브쿼리(회사 걸침 포함 — N:M).
   * 배정 계정 0개 코드도 노출(P1). wallet 없는 유저-only(MISSING) 코드는 검색 대상 아님 — 회사 스냅샷(getSettlementCodeSnapshot)에서 조회.
   */
  async searchSettlementCodes(filter: SettlementCodeSearchFilter): Promise<SettlementCodeSearchResult> {
    const limit = this.clampSearchLimit(filter.limit);
    if (filter.settleCondition !== undefined && !['PRE_PAYMENT', 'POST_PAYMENT'].includes(filter.settleCondition)) {
      throw new BadRequestException('settleCondition 은 PRE_PAYMENT | POST_PAYMENT 여야 합니다.');
    }
    if (filter.settleMethod !== undefined && !['CARD', 'CASH'].includes(filter.settleMethod)) {
      throw new BadRequestException('settleMethod 는 CARD | CASH 여야 합니다.');
    }
    this.assertRange(filter.depositMin, filter.depositMax, '예치금');
    this.assertRange(filter.creditLimitMin, filter.creditLimitMax, '여신한도');
    if (filter.cursor !== undefined && filter.cursor !== '' && !/^\d+$/.test(filter.cursor)) {
      throw new BadRequestException('cursor 는 정수 문자열이어야 합니다.');
    }
    if (filter.codeQuery !== undefined && filter.codeQuery.length > 50) {
      throw new BadRequestException('codeQuery 는 50자 이하여야 합니다.');
    }

    const qb = this.walletRepository
      .createQueryBuilder('w')
      .leftJoin(UserCompanyEntity, 'c', 'c.id = w.ownerCompanyId')
      .select('w.id', 'walletAccountId')
      .addSelect('w.ownerId', 'settlementCode')
      .addSelect('w.ownerCompanyId', 'ownerCompanyId')
      .addSelect('c.businessName', 'ownerCompanyName')
      .addSelect('w.settleCondition', 'settleCondition')
      .addSelect('w.settleMethod', 'settleMethod')
      .addSelect('w.depositBalance', 'depositBalance')
      .addSelect('w.creditLimit', 'creditLimit')
      .addSelect('w.creditUsedAmount', 'creditUsedAmount')
      .addSelect('w.creditExcessAmount', 'creditExcessAmount')
      .addSelect(
        (sub) =>
          sub
            .select('COUNT(DISTINCT u.id)')
            .from(UserEntity, 'u')
            .where("u.settlementCode = w.ownerId AND u.settlementCode <> ''"),
        'assignedUserCount',
      )
      .where('w.ownerType = :t', { t: 'SETTLEMENT_CODE' });

    if (filter.companyId !== undefined) qb.andWhere('w.ownerCompanyId = :cid', { cid: filter.companyId });
    if (filter.settleCondition !== undefined) qb.andWhere('w.settleCondition = :sc', { sc: filter.settleCondition });
    if (filter.settleMethod !== undefined) qb.andWhere('w.settleMethod = :sm', { sm: filter.settleMethod });
    if (filter.depositMin !== undefined) qb.andWhere('w.depositBalance >= :dmin', { dmin: filter.depositMin });
    if (filter.depositMax !== undefined) qb.andWhere('w.depositBalance <= :dmax', { dmax: filter.depositMax });
    if (filter.creditLimitMin !== undefined) qb.andWhere('w.creditLimit >= :lmin', { lmin: filter.creditLimitMin });
    if (filter.creditLimitMax !== undefined) qb.andWhere('w.creditLimit <= :lmax', { lmax: filter.creditLimitMax });
    if (filter.codeQuery && filter.codeQuery.trim() !== '') {
      // LIKE 와일드카드(%, _) + escape 문자 '!' 이스케이프 후 bound param 전달.
      // ESCAPE '!'를 명시해 sql_mode(NO_BACKSLASH_ESCAPES 등)와 무관하게 동작한다(backslash 의존 제거).
      const esc = filter.codeQuery.trim().replace(/[!%_]/g, '!$&');
      qb.andWhere("w.ownerId LIKE :cq ESCAPE '!'", { cq: `%${esc}%` });
    }
    if (filter.cursor !== undefined && filter.cursor !== '') {
      qb.andWhere('w.id > :cursor', { cursor: filter.cursor });
    }

    const rows = await qb
      .orderBy('w.id', 'ASC')
      .limit(limit + 1)
      .getRawMany<{
        walletAccountId: string;
        settlementCode: string;
        ownerCompanyId: number | string | null;
        ownerCompanyName: string | null;
        settleCondition: 'PRE_PAYMENT' | 'POST_PAYMENT';
        settleMethod: 'CARD' | 'CASH';
        depositBalance: string | number;
        creditLimit: string | number;
        creditUsedAmount: string | number;
        creditExcessAmount: string | number;
        assignedUserCount: string | number;
      }>();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items: SettlementCodeSearchItem[] = page.map((r) => ({
      settlementCode: r.settlementCode,
      walletAccountId: String(r.walletAccountId),
      ownerCompanyId: r.ownerCompanyId != null ? Number(r.ownerCompanyId) : null,
      ownerCompanyName: r.ownerCompanyName ?? null,
      walletStatus: 'ACTIVE',
      settleCondition: r.settleCondition,
      settleMethod: r.settleMethod,
      depositBalance: Number(r.depositBalance ?? 0),
      creditLimit: Number(r.creditLimit ?? 0),
      creditUsedAmount: Number(r.creditUsedAmount ?? 0),
      creditExcessAmount: Number(r.creditExcessAmount ?? 0),
      assignedUserCount: Number(r.assignedUserCount ?? 0),
    }));
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].walletAccountId : null;
    return { items, nextCursor };
  }

  private clampSearchLimit(limit?: number): number {
    if (limit === undefined) return SEARCH_LIMIT_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new BadRequestException('limit 은 1 이상 정수여야 합니다.');
    }
    return Math.min(limit, SEARCH_LIMIT_MAX);
  }

  private assertRange(min: number | undefined, max: number | undefined, label: string): void {
    for (const v of [min, max]) {
      if (v !== undefined && (!Number.isInteger(v) || v < 0)) {
        throw new BadRequestException(`${label} 범위는 0 이상 정수여야 합니다.`);
      }
    }
    if (min !== undefined && max !== undefined && min > max) {
      throw new BadRequestException(`${label} 범위 최소값이 최대값보다 큽니다.`);
    }
  }

  /**
   * settlement_code 키 단위 상세 조회 (N:M 대응).
   * 요청 회사 기준 rename 가능 여부를 실제 서버 규칙과 함께 반환한다.
   */
  async getSettlementCodeDetail(settlementCode: string, companyId: number): Promise<SettlementCodeDetail> {
    if (!settlementCode || settlementCode.trim() === '') {
      throw new BadRequestException('settlementCode 는 필수입니다.');
    }
    if (!Number.isInteger(companyId) || companyId < 1) {
      throw new BadRequestException('companyId 는 1 이상의 정수여야 합니다.');
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
        ownerCompanyId: null,
        renameAllowed: false,
        renameBlockReason: 'WALLET_MISSING',
        depositBalance: 0,
        creditLimit: 0,
        creditUsedAmount: 0,
        creditExcessAmount: 0,
        pointTotalRemaining: 0,
        settleCondition: null,
        settleMethod: null,
        cardSurchargeApplied: true,
        assignedAccounts,
      };
    }

    const ownerCompanyId = wallet.ownerCompanyId != null ? Number(wallet.ownerCompanyId) : null;
    let renameBlockReason: SettlementCodeRenameBlockReason | null = null;
    if (ownerCompanyId === null) {
      renameBlockReason = 'OWNER_COMPANY_MISSING';
    } else if (ownerCompanyId !== companyId) {
      renameBlockReason = 'NOT_OWNER_COMPANY';
    } else if (assignedAccounts.some((account) => account.companyId === null)) {
      renameBlockReason = 'COMPANYLESS_REFERENCE';
    } else if (assignedAccounts.some((account) => account.companyId !== ownerCompanyId)) {
      renameBlockReason = 'CROSS_COMPANY_REFERENCE';
    }

    return {
      settlementCode,
      walletAccountId: wallet.id,
      walletStatus: 'ACTIVE',
      ownerCompanyId,
      renameAllowed: renameBlockReason === null,
      renameBlockReason,
      depositBalance: wallet.depositBalance,
      creditLimit: wallet.creditLimit,
      creditUsedAmount: wallet.creditUsedAmount,
      creditExcessAmount: wallet.creditExcessAmount,
      pointTotalRemaining: await this.pointTotalRemaining(wallet.id),
      settleCondition: wallet.settleCondition,
      settleMethod: wallet.settleMethod,
      cardSurchargeApplied: wallet.cardSurchargeApplied,
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
    const codes = await this.companySettlementCodes(companyId);

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

  /**
   * 스냅샷/사용량/재배정 대상용 회사 정산코드 집합 (스펙 §2.3 — 목록 도출).
   *
   * = (a) 홈 회사가 이 회사인 wallet(owner_company_id, 유저 0명인 빈/고아 코드 포함)
   *   ∪ (b) 이 회사 사용자가 참조하는 코드(distinctSettlementCodes — 교차회사 공유 코드 가시성 유지).
   *
   * (a)가 유저 전원 재배정으로 사라지던 0계정 코드를 살린다(P1 데이터 유실 버그). (b)는 N:M 공유 코드·wallet MISSING 코드 유지.
   * settlement_code 기준 dedup(§2.5).
   */
  private async companySettlementCodes(companyId: number): Promise<string[]> {
    const [referenced, owned] = await Promise.all([
      this.distinctSettlementCodes(companyId),
      this.ownerCompanyWalletCodes(companyId),
    ]);
    // 숫자 인식 정렬: company-7-2 가 company-7-10 보다 앞(사전식이면 -10 이 앞으로 와 드롭박스 순서가 어색).
    return [...new Set([...referenced, ...owned])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  /**
   * 홈(발급) 회사가 이 회사인 정산코드 wallet owner_id (wallet_account.owner_company_id). 유저 0명인 빈 코드도 포함.
   *
   * owner_company_id 는 발급/생성 시 저장되고 리네임해도 불변이므로, 커스텀 이름으로 리네임된 코드도 결정론적으로 잡힌다
   * (네이밍 파싱 아님). 교차회사에서 사용 중인 타 회사 홈 코드는 distinctSettlementCodes 쪽 합집합으로 포함된다.
   */
  private async ownerCompanyWalletCodes(companyId: number): Promise<string[]> {
    const rows = await this.walletRepository
      .createQueryBuilder('w')
      .select('w.ownerId', 'ownerId')
      .where('w.ownerType = :t', { t: 'SETTLEMENT_CODE' })
      .andWhere('w.ownerCompanyId = :companyId', { companyId })
      .getRawMany<{ ownerId: string }>();
    return rows.map((r) => r.ownerId);
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
