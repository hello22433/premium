import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { GALAXIA_SUB_ITEM_KEY_MOBILE, GALAXIA_SUB_ITEM_KEYS, SUB_ITEM_KEY_NONE } from './settle.sub.item.key';

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

/** 갤럭시아 하위항목(subItemKey) — 표시 순서. 쿠폰(모바일) + 백화점 브랜드 3종(각각 별도 선충전). */
export const GALAXIA_SUB_ITEM_ORDER = GALAXIA_SUB_ITEM_KEYS;

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

/** config/조회에서 허용하는 (협력사 타입, 하위항목) 축인지 fail-closed 검증한다. */
export function isValidCreditSubItemKey(partnerType: IPartnerCompanyType, subItemKey: string): boolean {
  return CREDIT_ROW_AXIS.some((spec) => spec.partnerType === partnerType && spec.subItemKey === subItemKey);
}

/** 발송가능잔액 산출 방식(정본 §4.3). PREPAID_LEDGER = 갤럭시아 백화점 선충전(충전금액 − Σ정산액). */
export type BalanceSourceKind = 'SSG_EVENT' | 'LIMIT_MINUS_UNSETTLED' | 'EXTERNAL_INQUIRY' | 'PREPAID_LEDGER';

/** (협력사 타입, 하위항목) → 발송가능잔액 산출 방식. */
export function balanceSourceKind(partnerType: IPartnerCompanyType, subItemKey: string): BalanceSourceKind {
  switch (partnerType) {
    case IPartnerCompanyType.SSG:
      return 'SSG_EVENT';
    case IPartnerCompanyType.GIFT_SHOW:
      return 'EXTERNAL_INQUIRY';
    case IPartnerCompanyType.GALAXIA:
      if (!GALAXIA_SUB_ITEM_ORDER.includes(subItemKey as (typeof GALAXIA_SUB_ITEM_ORDER)[number])) {
        throw new Error(`갤럭시아 여신 표 하위항목 미등록: ${subItemKey}`);
      }
      // 쿠폰(MOBILE)은 여신, 백화점 3브랜드(롯데·현대·갤러리아)는 각각 선충전.
      return subItemKey === GALAXIA_SUB_ITEM_KEY_MOBILE ? 'LIMIT_MINUS_UNSETTLED' : 'PREPAID_LEDGER';
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
