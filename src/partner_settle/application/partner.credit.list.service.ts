import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { PartnerCreditConfigEntity } from '../../entity/partner.credit.config.entity';
import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';
import { PartnerProviderEventInboxEntity } from '../../entity/partner.provider.event.inbox.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { serializeAmount } from '../domain/credit.amount.string';
import { calculateMonthlyLimit } from '../domain/credit.monthly.limit';
import { balanceSourceKind, CREDIT_ROW_AXIS } from '../domain/credit.row.axis';
import { buildCreditRow, CreditListRow, CreditRowAggregate, ResolvedBalance } from '../domain/credit.list.assembly';
import { startOfMonthKst } from '../domain/settle.time';
import { IPartnerBalanceInquiry, PartnerBalanceResult } from '../interface/partner.balance.inquiry';
import { PARTNER_BALANCE_INQUIRIES } from './partner.balance.inquiry.token';

export type PaymentVarianceRow = {
  partnerCompanyId: number;
  partnerType: IPartnerCompanyType;
  subItemKey: 'PAYMENT_VARIANCE';
  paymentVarianceAdjustmentAmount: string;
  monthlyLimit: null;
  availableBalance: null;
};

export type CreditListResponse = {
  rows: CreditListRow[];
  paymentVarianceRows: PaymentVarianceRow[];
};

const TARGET_TYPES: readonly IPartnerCompanyType[] = Array.from(new Set(CREDIT_ROW_AXIS.map((r) => r.partnerType)));

const ACTIVE_STATUSES = ['NORMAL', 'ON_HOLD'];

type Agg = CreditRowAggregate;

/**
 * 여신 표 조회 (정본 §4.2·§4.3 · §9 credit/list · 현재 스냅샷 전용 · 23차·33차-H11).
 *
 * 원장(PR1B)을 **읽기만** 한다. 미정산·전월·NEEDS_REVIEW·orphan·지급조정을 (협력사, 하위항목)별로
 * 집계하고 fail-closed(3차 H1·65차-B1)를 적용한다.
 */
@Injectable()
export class PartnerCreditListService {
  private readonly logger = new Logger(PartnerCreditListService.name);

  constructor(
    @InjectRepository(PartnerCompanyEntity)
    private readonly partnerRepository: Repository<PartnerCompanyEntity>,
    @InjectRepository(PartnerCreditConfigEntity)
    private readonly configRepository: Repository<PartnerCreditConfigEntity>,
    @InjectRepository(PartnerSettleLedgerEntity)
    private readonly ledgerRepository: Repository<PartnerSettleLedgerEntity>,
    @InjectRepository(PartnerProviderEventInboxEntity)
    private readonly inboxRepository: Repository<PartnerProviderEventInboxEntity>,
    @InjectRepository(SsgEventEntity)
    private readonly ssgEventRepository: Repository<SsgEventEntity>,
    @Inject(PARTNER_BALANCE_INQUIRIES)
    private readonly balanceInquiries: IPartnerBalanceInquiry[],
  ) {}

  async getList(now: Date = new Date()): Promise<CreditListResponse> {
    const partnersByType = await this.loadPartnersByType();
    const partnerIds = [...partnersByType.values()].map((p) => p.id);
    if (partnerIds.length === 0) {
      return { rows: [], paymentVarianceRows: [] };
    }

    const [aggMap, configMap, ssgBalance, orphanByPartner, varianceByPartner, balancesByPartner, prepaidSpentMap] =
      await Promise.all([
        this.aggregateLedger(partnerIds, now),
        this.loadConfigs(partnerIds),
        this.sumActiveSsgEventBalance(now),
        this.orphanPendingByPartner(partnerIds),
        this.paymentVarianceByPartner(partnerIds),
        this.loadExternalBalances(partnersByType),
        this.prepaidSpentByKey(partnerIds),
      ]);

    const rows: CreditListRow[] = [];
    for (const spec of CREDIT_ROW_AXIS) {
      const partner = partnersByType.get(spec.partnerType);
      if (!partner) continue; // 대상 협력사 미존재 — 행 생략(로그는 loadPartnersByType 에서)

      const key = rowKey(partner.id, spec.subItemKey);
      const agg: CreditRowAggregate = aggMap.get(key) ?? {
        unsettled: 0n,
        prevMonth: 0n,
        reviewCount: 0,
        reviewBase: 0n,
      };
      const cfg = configMap.get(key) ?? { insuranceAmount: 0n, prepaidAmount: 0n, etcAmount: 0n };
      const monthlyLimit = calculateMonthlyLimit(spec.partnerType, cfg, spec.subItemKey);
      const orphanCount = orphanByPartner.get(partner.id) ?? 0;

      // 갤럭시아는 실 config 미등록 상태에서 0-spent를 숫자로 노출하면 배포 즉시 오판한다.
      const balance =
        spec.partnerType === IPartnerCompanyType.GALAXIA && !configMap.has(key)
          ? ({ balance: null, status: 'NOT_AVAILABLE' } as const)
          : this.resolveBalance(
              spec.partnerType,
              spec.subItemKey,
              monthlyLimit,
              agg.unsettled,
              ssgBalance,
              balancesByPartner.get(partner.id),
              prepaidSpentMap.get(key) ?? 0n,
            );

      rows.push(
        buildCreditRow({
          spec,
          partnerCompanyId: partner.id,
          partnerName: partner.businessName,
          monthlyLimit,
          agg,
          orphanCount,
          balance,
        }),
      );
    }

    const paymentVarianceRows: PaymentVarianceRow[] = [];
    for (const [partnerId, amount] of varianceByPartner) {
      const partner = [...partnersByType.values()].find((p) => p.id === partnerId);
      if (!partner || amount === 0n) continue;
      paymentVarianceRows.push({
        partnerCompanyId: partnerId,
        partnerType: partner.type as IPartnerCompanyType,
        subItemKey: 'PAYMENT_VARIANCE',
        paymentVarianceAdjustmentAmount: serializeAmount(amount),
        monthlyLimit: null,
        availableBalance: null,
      });
    }

    return { rows, paymentVarianceRows };
  }

  /** 발송가능잔액 산출 — 방식별(§4.3). fail-closed 는 상위에서 null 처리한다. */
  private resolveBalance(
    partnerType: IPartnerCompanyType,
    subItemKey: string,
    monthlyLimit: bigint,
    unsettled: bigint,
    ssgBalance: bigint | null,
    externalBalances: PartnerBalanceResult[] | undefined,
    prepaidSpent: bigint,
  ): ResolvedBalance {
    switch (balanceSourceKind(partnerType, subItemKey)) {
      case 'LIMIT_MINUS_UNSETTLED':
        return { balance: monthlyLimit - unsettled, status: 'AVAILABLE' };
      case 'PREPAID_LEDGER':
        // 선충전 충전금액(monthlyLimit) − 정산액 소진 합계. 정산확정과 무관하게 영구 차감.
        return { balance: monthlyLimit - prepaidSpent, status: 'AVAILABLE' };
      case 'SSG_EVENT':
        if (ssgBalance === null) return { balance: null, status: 'NOT_AVAILABLE' };
        return { balance: ssgBalance, status: 'AVAILABLE' };
      case 'EXTERNAL_INQUIRY': {
        const found = externalBalances?.find((b) => b.subItemKey === subItemKey);
        if (!found) return { balance: null, status: 'NOT_AVAILABLE' };
        return { balance: found.balance === null ? null : BigInt(found.balance), status: found.status };
      }
    }
  }

  /**
   * 선충전(갤럭시아 백화점) 소진액 = Σ settle_amount (수수료 뺀 정산액).
   * 정산확정 무관 전체 배치 합산 — 선충전은 발송 즉시 영구 차감이라 settle_batch_id 필터 없음.
   * 역분개(취소)는 음수 settle_amount 로 자동 상쇄. ADJUSTMENT(내부 차액정정)는 제외.
   */
  private async prepaidSpentByKey(partnerIds: number[]): Promise<Map<string, bigint>> {
    const rows = await this.ledgerRepository
      .createQueryBuilder('l')
      .select('l.partner_company_id', 'partnerCompanyId')
      .addSelect('l.sub_item_key', 'subItemKey')
      .addSelect(
        `SUM(CASE WHEN l.status IN (:...active) AND l.source_type <> 'ADJUSTMENT' THEN COALESCE(l.settle_amount, 0) ELSE 0 END)`,
        'spent',
      )
      .where('l.partner_company_id IN (:...partnerIds)', { partnerIds })
      .setParameters({ active: ACTIVE_STATUSES })
      .groupBy('l.partner_company_id')
      .addGroupBy('l.sub_item_key')
      .getRawMany<{ partnerCompanyId: number; subItemKey: string; spent: string | null }>();
    const map = new Map<string, bigint>();
    for (const r of rows) map.set(rowKey(r.partnerCompanyId, r.subItemKey), BigInt(r.spent ?? '0'));
    return map;
  }

  private async loadPartnersByType(): Promise<Map<IPartnerCompanyType, PartnerCompanyEntity>> {
    const partners = await this.partnerRepository.find({
      where: { type: In([...TARGET_TYPES]) },
      order: { id: 'ASC' },
    });
    const map = new Map<IPartnerCompanyType, PartnerCompanyEntity>();
    for (const partner of partners) {
      if (!partner.type) continue;
      if (map.has(partner.type)) {
        this.logger.warn(
          `협력사 type=${partner.type} 이 2건 이상 — id=${map.get(partner.type)!.id} 사용, id=${partner.id} 무시`,
        );
        continue;
      }
      map.set(partner.type, partner);
    }
    for (const type of TARGET_TYPES) {
      if (!map.has(type)) this.logger.warn(`여신 표 대상 협력사 미존재: type=${type} (행 생략)`);
    }
    return map;
  }

  private async aggregateLedger(partnerIds: number[], now: Date): Promise<Map<string, Agg>> {
    const thisMonthStart = startOfMonthKst(now);
    const prevMonthStart = new Date(thisMonthStart.getFullYear(), thisMonthStart.getMonth() - 1, 1, 0, 0, 0, 0);

    const rows = await this.ledgerRepository
      .createQueryBuilder('l')
      .select('l.partner_company_id', 'partnerCompanyId')
      .addSelect('l.sub_item_key', 'subItemKey')
      // 미정산 정가 합계 (settleBatchId NULL · NORMAL/ON_HOLD · ADJUSTMENT 제외 · 77차·33차-3)
      .addSelect(
        `SUM(CASE WHEN l.settle_batch_id IS NULL AND l.status IN (:...active) AND l.source_type <> 'ADJUSTMENT' THEN l.base_amount ELSE 0 END)`,
        'unsettled',
      )
      // 전월 단순 발송금액 (양수 row·직전 마감 월·확정분 포함·netting 미적용 · O11)
      .addSelect(
        `SUM(CASE WHEN l.base_amount > 0 AND l.status IN (:...active) AND l.source_type <> 'ADJUSTMENT'
                    AND l.occurred_at >= :prevStart AND l.occurred_at < :thisStart THEN l.base_amount ELSE 0 END)`,
        'prevMonth',
      )
      // 미해소 NEEDS_REVIEW (DISCARDED 제외 · 3차 H1)
      .addSelect(
        `SUM(CASE WHEN l.status = 'NEEDS_REVIEW' AND (l.review_resolution IS NULL OR l.review_resolution = 'PENDING') THEN 1 ELSE 0 END)`,
        'reviewCount',
      )
      .addSelect(
        `SUM(CASE WHEN l.status = 'NEEDS_REVIEW' AND (l.review_resolution IS NULL OR l.review_resolution = 'PENDING') THEN COALESCE(l.base_amount, 0) ELSE 0 END)`,
        'reviewBase',
      )
      .where('l.partner_company_id IN (:...partnerIds)', { partnerIds })
      .andWhere(`l.sub_item_key <> 'PAYMENT_VARIANCE'`)
      .setParameters({
        active: ACTIVE_STATUSES,
        prevStart: this.toDbString(prevMonthStart),
        thisStart: this.toDbString(thisMonthStart),
      })
      .groupBy('l.partner_company_id')
      .addGroupBy('l.sub_item_key')
      .getRawMany<{
        partnerCompanyId: number;
        subItemKey: string;
        unsettled: string | null;
        prevMonth: string | null;
        reviewCount: string | null;
        reviewBase: string | null;
      }>();

    const map = new Map<string, Agg>();
    for (const r of rows) {
      map.set(rowKey(r.partnerCompanyId, r.subItemKey), {
        unsettled: BigInt(r.unsettled ?? '0'),
        prevMonth: BigInt(r.prevMonth ?? '0'),
        reviewCount: Number(r.reviewCount ?? '0'),
        reviewBase: BigInt(r.reviewBase ?? '0'),
      });
    }
    return map;
  }

  private async loadConfigs(
    partnerIds: number[],
  ): Promise<Map<string, { insuranceAmount: bigint; prepaidAmount: bigint; etcAmount: bigint }>> {
    const rows = await this.configRepository.find({ where: { partnerCompanyId: In(partnerIds) } });
    const map = new Map<string, { insuranceAmount: bigint; prepaidAmount: bigint; etcAmount: bigint }>();
    for (const row of rows) {
      map.set(rowKey(row.partnerCompanyId, row.subItemKey), {
        insuranceAmount: BigInt(row.insuranceAmount),
        prepaidAmount: BigInt(row.prepaidAmount),
        etcAmount: BigInt(row.etcAmount),
      });
    }
    return map;
  }

  /** 현재 활성 SSG 행사 잔액 합계. 활성 행사 없으면 null(NOT_AVAILABLE). */
  private async sumActiveSsgEventBalance(now: Date): Promise<bigint | null> {
    const raw = await this.ssgEventRepository
      .createQueryBuilder('e')
      .select('SUM(e.event_balance)', 'total')
      .addSelect('COUNT(*)', 'cnt')
      .where('e.start_at <= :now AND e.end_at >= :now', { now: this.toDbString(now) })
      .getRawOne<{ total: string | null; cnt: string }>();
    if (!raw || Number(raw.cnt ?? '0') === 0) return null;
    return BigInt(raw.total ?? '0');
  }

  /** provider 별 orphan 미원장(ORPHAN_PENDING) 수. PR2 는 provider 단위 fail-closed(보수적). */
  private async orphanPendingByPartner(partnerIds: number[]): Promise<Map<number, number>> {
    const partners = await this.partnerRepository.find({
      where: { id: In(partnerIds) },
      select: ['id', 'type'],
    });
    const typeToId = new Map<IPartnerCompanyType, number>();
    for (const p of partners) if (p.type) typeToId.set(p.type, p.id);

    const rows = await this.inboxRepository
      .createQueryBuilder('i')
      .select('i.provider', 'provider')
      .addSelect('COUNT(*)', 'cnt')
      .where(`i.origin = 'ORPHAN' AND i.processed_status = 'ORPHAN_PENDING'`)
      .groupBy('i.provider')
      .getRawMany<{ provider: IPartnerCompanyType; cnt: string }>();

    const map = new Map<number, number>();
    for (const r of rows) {
      const id = typeToId.get(r.provider);
      if (id !== undefined) map.set(id, Number(r.cnt ?? '0'));
    }
    return map;
  }

  private async paymentVarianceByPartner(partnerIds: number[]): Promise<Map<number, bigint>> {
    const rows = await this.ledgerRepository
      .createQueryBuilder('l')
      .select('l.partner_company_id', 'partnerCompanyId')
      .addSelect('SUM(l.settle_amount)', 'total')
      .where('l.partner_company_id IN (:...partnerIds)', { partnerIds })
      .andWhere(`l.sub_item_key = 'PAYMENT_VARIANCE' AND l.settle_batch_id IS NULL AND l.status = 'NORMAL'`)
      .groupBy('l.partner_company_id')
      .getRawMany<{ partnerCompanyId: number; total: string | null }>();
    const map = new Map<number, bigint>();
    for (const r of rows) map.set(r.partnerCompanyId, BigInt(r.total ?? '0'));
    return map;
  }

  private async loadExternalBalances(
    partnersByType: Map<IPartnerCompanyType, PartnerCompanyEntity>,
  ): Promise<Map<number, PartnerBalanceResult[]>> {
    const map = new Map<number, PartnerBalanceResult[]>();
    for (const inquiry of this.balanceInquiries) {
      const partner = partnersByType.get(inquiry.provider);
      if (!partner) continue;
      map.set(partner.id, await inquiry.getBalances(partner.id));
    }
    return map;
  }

  /** KST naive DATETIME 파라미터 문자열. 서버 TZ=Asia/Seoul, DB 커넥션 +09:00. */
  private toDbString(date: Date): string {
    const pad = (v: number, w = 2) => String(v).padStart(w, '0');
    return (
      `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds() * 1000, 6)}`
    );
  }
}

function rowKey(partnerCompanyId: number, subItemKey: string): string {
  return `${partnerCompanyId}::${subItemKey}`;
}
