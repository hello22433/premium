import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';

/**
 * 협력사 월 한도 계산 (정본 §4.4).
 *
 * 월 한도는 DB 에 저장하지 않고 여신 설정(보증보험/선입금/기타)에서 협력사 타입별 공식으로 계산한다.
 * 전 구간 `bigint` 정수산술이다(2^53 초과 정확성 · §5 금액 계약).
 *
 * 공식(§4.4):
 * - `SSG` / `GIFT_SHOW` / `GALAXIA` / `CULTURELAND` : 선입금 + 기타
 * - `DAOU` / `GIFTIEL`                              : 보증보험 + 선입금 + 기타
 *
 * 여신 표 6개 협력사 밖(`GS_M_BIZ` 등)은 대상이 아니며 추정 공식 금지 — 미매핑 타입은 fail-closed(에러).
 */

export class UnsupportedCreditPartnerTypeError extends Error {}

/** 보증보험을 월 한도에 포함하는 협력사 타입(다우기술·스푼). */
const INSURANCE_INCLUDED_TYPES: ReadonlySet<IPartnerCompanyType> = new Set([
  IPartnerCompanyType.DAOU,
  IPartnerCompanyType.GIFTIEL,
]);

/** 선입금+기타 만 쓰는 협력사 타입(이마트·케이티알파·갤럭시아·한국문화진흥). */
const PREPAID_ONLY_TYPES: ReadonlySet<IPartnerCompanyType> = new Set([
  IPartnerCompanyType.SSG,
  IPartnerCompanyType.GIFT_SHOW,
  IPartnerCompanyType.GALAXIA,
  IPartnerCompanyType.CULTURELAND,
]);

export type CreditConfigAmounts = {
  insuranceAmount: bigint;
  prepaidAmount: bigint;
  etcAmount: bigint;
};

/**
 * 협력사 타입 + 여신 설정 → 월 한도(`bigint`).
 *
 * 미매핑 타입은 `UnsupportedCreditPartnerTypeError` 로 fail-closed 한다(추정 금지).
 */
export function calculateMonthlyLimit(
  partnerType: IPartnerCompanyType,
  amounts: CreditConfigAmounts,
): bigint {
  const prepaidAndEtc = amounts.prepaidAmount + amounts.etcAmount;

  if (INSURANCE_INCLUDED_TYPES.has(partnerType)) {
    return amounts.insuranceAmount + prepaidAndEtc;
  }
  if (PREPAID_ONLY_TYPES.has(partnerType)) {
    return prepaidAndEtc;
  }
  throw new UnsupportedCreditPartnerTypeError(`여신 표 대상 아님 · 월 한도 공식 미정의: ${partnerType}`);
}

/**
 * 여신 표(월 한도 공식) 대상 협력사 타입인지 여부.
 *
 * config 쓰기(PUT) 시작에서 이 술어로 걸러야 한다 — 통과시키면 비대상 type 에 설정이 생성된 뒤
 * 조회(GET)에서만 `calculateMonthlyLimit` 이 400 을 내 "쓰기는 성공·읽기는 깨짐" 상태가 된다.
 */
export function isSupportedCreditPartnerType(partnerType: IPartnerCompanyType): boolean {
  return INSURANCE_INCLUDED_TYPES.has(partnerType) || PREPAID_ONLY_TYPES.has(partnerType);
}
