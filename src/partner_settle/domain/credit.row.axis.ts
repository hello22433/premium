import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { SUB_ITEM_KEY_NONE } from './settle.sub.item.key';

/**
 * 여신 표 행 축 (정본 §4.1 표시 순서 · 2026-07-29 A 최종 확정).
 *
 * 6개 협력사와 각 하위항목(subItemKey)을 **표시 순서 그대로** 나열한다. 프론트 렌더·§13 테스트의
 * 단일 기준이다. 갤럭시아 4행·한국문화진흥 2행만 세분되고 나머지는 sentinel `NONE` 이다.
 *
 * ⚠️ `GS_M_BIZ`(GS 엠비즈)는 enum 에 있으나 여신 표 6개 협력사 밖이라 제외한다(정본 §1 참고 주석).
 */

export type CreditRowSpec = {
  partnerType: IPartnerCompanyType;
  subItemKey: string;
  /** 기본 숨김 여부(갤럭시아 롯데만 true). 자동 재표시 판정은 서비스가 한다 (§4.1 O10). */
  hiddenByDefault: boolean;
};

/** 갤럭시아 하위항목(subItemKey) — 표시 순서. */
export const GALAXIA_SUB_ITEM_ORDER = [
  'GALAXIA_MOBILE',
  'GALAXIA_LOTTE',
  'GALAXIA_HYUNDAI',
  'GALAXIA_GALLERIA',
] as const;

/** 한국문화진흥 하위항목 — 표시 순서(5년 → 60일). */
export const CULTURE_SUB_ITEM_ORDER = ['CULTURE_5Y', 'CULTURE_60D'] as const;

/** 기본 숨김 하위항목 (O10 — 갤럭시아 롯데). */
export const HIDDEN_BY_DEFAULT_SUB_ITEM_KEYS: ReadonlySet<string> = new Set(['GALAXIA_LOTTE']);

/**
 * 표시 순서: 이마트 → 케이티알파 → 다우기술 → 스푼 → 갤럭시아(4) → 한국문화진흥(2).
 */
export const CREDIT_ROW_AXIS: readonly CreditRowSpec[] = [
  row(IPartnerCompanyType.SSG, SUB_ITEM_KEY_NONE),
  row(IPartnerCompanyType.GIFT_SHOW, SUB_ITEM_KEY_NONE),
  row(IPartnerCompanyType.DAOU, SUB_ITEM_KEY_NONE),
  row(IPartnerCompanyType.GIFTIEL, SUB_ITEM_KEY_NONE),
  ...GALAXIA_SUB_ITEM_ORDER.map((key) => row(IPartnerCompanyType.GALAXIA, key)),
  ...CULTURE_SUB_ITEM_ORDER.map((key) => row(IPartnerCompanyType.CULTURELAND, key)),
];

/** 발송가능잔액 산출 방식(정본 §4.3). */
export type BalanceSourceKind = 'SSG_EVENT' | 'LIMIT_MINUS_UNSETTLED' | 'EXTERNAL_INQUIRY';

/** 협력사 타입 → 발송가능잔액 산출 방식. */
export function balanceSourceKind(partnerType: IPartnerCompanyType): BalanceSourceKind {
  switch (partnerType) {
    case IPartnerCompanyType.SSG:
      return 'SSG_EVENT';
    case IPartnerCompanyType.GIFT_SHOW:
    case IPartnerCompanyType.GALAXIA:
      return 'EXTERNAL_INQUIRY';
    case IPartnerCompanyType.DAOU:
    case IPartnerCompanyType.GIFTIEL:
    case IPartnerCompanyType.CULTURELAND:
      return 'LIMIT_MINUS_UNSETTLED';
    default:
      throw new Error(`여신 표 대상 아님 · 발송가능잔액 방식 미정의: ${partnerType}`);
  }
}

/** SSG 는 미정산 정가 합계 산식 비적용(§4.3·§6.5 · 42차-H1 → unsettledBaseAmount = null). */
export function isUnsettledExempt(partnerType: IPartnerCompanyType): boolean {
  return partnerType === IPartnerCompanyType.SSG;
}

function row(partnerType: IPartnerCompanyType, subItemKey: string): CreditRowSpec {
  return { partnerType, subItemKey, hiddenByDefault: HIDDEN_BY_DEFAULT_SUB_ITEM_KEYS.has(subItemKey) };
}
