import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';

/**
 * 협력사 여신한도 잔액조회 (정본 §9.1).
 *
 * 상태↔balance 불변식 (60차-M1):
 * - `AVAILABLE ⟺ balance !== null` (정상 조회·값 유효, 정상 0원은 `AVAILABLE` + `'0'`)
 * - `NOT_AVAILABLE | FAILED ⟹ balance === null` (미연동 stub·호출 실패·비대상)
 * - `FAILED` = 연동됐으나 호출 실패(`reason`), `NOT_AVAILABLE` = 미연동/비대상
 */
export type PartnerBalanceStatus = 'AVAILABLE' | 'NOT_AVAILABLE' | 'FAILED';

export interface PartnerBalanceResult {
  /** 하위항목 키. 하위 없으면 sentinel `'NONE'`. */
  subItemKey: string;
  status: PartnerBalanceStatus;
  /** canonical 정수 문자열 or null. 불변식은 `assertBalanceInvariant` 로 강제. */
  balance: string | null;
  reason?: string;
  fetchedAt?: string;
}

/**
 * 외부 여신한도 조회 대상 provider(케이티알파)의 하위항목별 잔액을 조회한다.
 * 케이티알파는 기프티쇼 포인트 API로 실연동한다. 갤럭시아는 제공 API가 없어 외부조회 대상이
 * 아니며, 다른 협력사처럼 월한도−미정산(LIMIT_MINUS_UNSETTLED)으로 산출한다.
 */
export interface IPartnerBalanceInquiry {
  /** 이 adapter 가 처리하는 provider. */
  readonly provider: IPartnerCompanyType;
  getBalances(partnerCompanyId: number): Promise<PartnerBalanceResult[]>;
}

export class BalanceInvariantError extends Error {}

/** 상태↔balance 불변식 강제 (60차-M1). adapter·소비자·테스트 공용. */
export function assertBalanceInvariant(result: PartnerBalanceResult): PartnerBalanceResult {
  const hasBalance = result.balance !== null;
  const shouldHaveBalance = result.status === 'AVAILABLE';
  if (hasBalance !== shouldHaveBalance) {
    throw new BalanceInvariantError(
      `balance 불변식 위반: status=${result.status}, balance=${JSON.stringify(result.balance)}`,
    );
  }
  return result;
}
