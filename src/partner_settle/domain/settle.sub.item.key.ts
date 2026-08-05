import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';

/**
 * 원장 하위항목 키 (정본 §4.1 · §14 O1·O2).
 *
 * 갤럭시아 4종·한국문화진흥 2종만 세분되고 나머지 협력사는 `NONE` 이다.
 * 매핑 키는 **`brand.code`(안정 업무키)** 이며 `brand.id`(auto PK)는 쓰지 않는다.
 *
 * **미등록 값은 fail-closed** 다 — 추정 매핑으로 원장을 만들면 하위항목 귀속이 영구히 틀어진다
 * (`subItemKey` 는 원장 불변값이다). 호출부는 이 예외를 원장 미생성 + 운영자 확인으로 처리한다.
 */

export const SUB_ITEM_KEY_NONE = 'NONE';

export const GALAXIA_SUB_ITEM_KEY_BY_BRAND_CODE: Readonly<Record<string, string>> = {
  EBR00025: 'GALAXIA_LOTTE',
  EBR00026: 'GALAXIA_HYUNDAI',
  EBR00037: 'GALAXIA_GALLERIA',
};

export const GALAXIA_SUB_ITEM_KEY_MOBILE = 'GALAXIA_MOBILE';

/** 한국문화진흥은 유효기간 일수로만 갈린다. `else → 5Y` 매핑은 미래 값을 오귀속하므로 금지. */
export const CULTURE_SUB_ITEM_KEY_BY_EXPIRE_DAY: Readonly<Record<number, string>> = {
  60: 'CULTURE_60D',
  1825: 'CULTURE_5Y',
};

export class SubItemKeyUnresolvedError extends Error {}

export type SubItemKeyInput = {
  provider: IPartnerCompanyType;
  /** 갤럭시아 상품권 종류 (`cpn` 쿠폰 / `dept` 백화점 상품권) */
  giftKind?: string | null;
  /** 갤럭시아 dept 브랜드 업무키 */
  brandCode?: string | null;
  /** 한국문화진흥 유효기간 일수 — `order_product_mapping.snapshotProductExpireDay`(불변 스냅샷) */
  snapshotProductExpireDay?: number | null;
};

export function resolveSubItemKey(input: SubItemKeyInput): string {
  switch (input.provider) {
    case IPartnerCompanyType.GALAXIA:
      return resolveGalaxiaSubItemKey(input);
    case IPartnerCompanyType.CULTURELAND:
      return resolveCulturelandSubItemKey(input);
    default:
      return SUB_ITEM_KEY_NONE;
  }
}

function resolveGalaxiaSubItemKey(input: SubItemKeyInput): string {
  const giftKind = (input.giftKind ?? '').trim().toLowerCase();
  if (giftKind === 'cpn') return GALAXIA_SUB_ITEM_KEY_MOBILE;
  if (giftKind !== 'dept') {
    throw new SubItemKeyUnresolvedError(`갤럭시아 giftKind 미등록: ${input.giftKind}`);
  }

  const brandCode = (input.brandCode ?? '').trim();
  const mapped = GALAXIA_SUB_ITEM_KEY_BY_BRAND_CODE[brandCode];
  if (!mapped) {
    throw new SubItemKeyUnresolvedError(`갤럭시아 dept brand.code 미등록: ${input.brandCode}`);
  }
  return mapped;
}

function resolveCulturelandSubItemKey(input: SubItemKeyInput): string {
  const expireDay = input.snapshotProductExpireDay;
  if (expireDay === null || expireDay === undefined) {
    throw new SubItemKeyUnresolvedError('한국문화진흥 snapshotProductExpireDay 결측');
  }
  const mapped = CULTURE_SUB_ITEM_KEY_BY_EXPIRE_DAY[expireDay];
  if (!mapped) {
    throw new SubItemKeyUnresolvedError(`한국문화진흥 유효기간 미등록: ${expireDay}`);
  }
  return mapped;
}
