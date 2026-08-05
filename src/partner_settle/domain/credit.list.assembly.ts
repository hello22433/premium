import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { serializeAmount } from './credit.amount.string';
import { CreditRowSpec, isUnsettledExempt } from './credit.row.axis';
import { PartnerBalanceStatus } from '../interface/partner.balance.inquiry';

/**
 * 여신 표 1행 조립 (정본 §4.2·§4.3·§9 · fail-closed 3차 H1·65차-B1 · O10 · O11).
 *
 * SQL 집계·외부 잔액조회는 서비스가 수행하고, 그 결과를 이 순수 함수가 표시 계약으로 조립한다.
 * fail-closed·SSG 미정산 예외·롯데 자동 재표시·상태 우선순위는 SQL 과 무관하므로 여기서 결정·검증한다.
 */

export type CreditListRow = {
  partnerCompanyId: number;
  partnerType: IPartnerCompanyType;
  partnerName: string;
  subItemKey: string;
  monthlyLimit: string;
  /** 미정산 정가 합계. SSG 는 null(§4.3 예외). */
  unsettledBaseAmount: string | null;
  previousMonthBaseAmount: string;
  availableBalance: string | null;
  balanceSourceStatus: PartnerBalanceStatus;
  creditDataStatus: 'OK' | 'NEEDS_REVIEW';
  reviewCount: number;
  reviewBaseAmount: string;
  orphanPendingCount: number;
  hidden: boolean;
};

export type CreditRowAggregate = {
  unsettled: bigint;
  prevMonth: bigint;
  reviewCount: number;
  reviewBase: bigint;
};

export type ResolvedBalance = { balance: bigint | null; status: PartnerBalanceStatus };

export type BuildCreditRowInput = {
  spec: CreditRowSpec;
  partnerCompanyId: number;
  partnerName: string;
  monthlyLimit: bigint;
  agg: CreditRowAggregate;
  orphanCount: number;
  balance: ResolvedBalance;
};

export function buildCreditRow(input: BuildCreditRowInput): CreditListRow {
  const { spec, agg, balance } = input;

  // SSG 는 미정산 정가 합계 산식 비적용(eventBalance track) → null.
  const unsettledBaseAmount = isUnsettledExempt(spec.partnerType) ? null : agg.unsettled;

  // fail-closed: 미해소 NEEDS_REVIEW 또는 미원장 orphan 이 있으면 발송가능잔액을 숫자로 노출하지 않는다.
  // 외부 잔액조회가 성공(AVAILABLE)이어도 차단 상태가 우선한다(33차-7.3).
  const failClosed = agg.reviewCount > 0 || input.orphanCount > 0;
  const availableBalance = failClosed ? null : balance.balance;

  // 갤럭시아 롯데: 기본 숨김 + (미정산≠0 OR 전월≠0)이면 자동 재표시. 발송가능잔액은 판정 제외(O10).
  const hidden =
    spec.hiddenByDefault &&
    (unsettledBaseAmount === null || unsettledBaseAmount === 0n) &&
    agg.prevMonth === 0n;

  return {
    partnerCompanyId: input.partnerCompanyId,
    partnerType: spec.partnerType,
    partnerName: input.partnerName,
    subItemKey: spec.subItemKey,
    monthlyLimit: serializeAmount(input.monthlyLimit),
    unsettledBaseAmount: unsettledBaseAmount === null ? null : serializeAmount(unsettledBaseAmount),
    previousMonthBaseAmount: serializeAmount(agg.prevMonth),
    availableBalance: availableBalance === null ? null : serializeAmount(availableBalance),
    balanceSourceStatus: balance.status,
    creditDataStatus: failClosed ? 'NEEDS_REVIEW' : 'OK',
    reviewCount: agg.reviewCount,
    reviewBaseAmount: serializeAmount(agg.reviewBase),
    orphanPendingCount: input.orphanCount,
    hidden,
  };
}
