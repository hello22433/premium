import { IUserDiscountCategory } from '../../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../../user_discount/interface/user.discount.method';
import { ICompareCondition } from '../../user_discount/interface/compare.condition';

/**
 * 협력사 정산조건 scope 의 canonical key 생성.
 *
 * 문자열 개념만으로는 DB 가 유일성·잠금을 강제할 수 없으므로 이 함수의 결과를
 * `partner_discount_history.scope_key` · `partner_discount_scope.scope_key` 에 실제 컬럼으로 저장한다.
 * 대조는 `utf8mb4_bin` 이라 대소문자·공백이 그대로 유효 문자다.
 *
 * 키는 **단일 출처**다. 서비스에서 문자열을 직접 조립하지 않는다.
 */

const SCOPE_KEY_PREFIX = 'sk1';
const POLICY_TARGET_KEY_PREFIX = 'pt1';
const NULL_SENTINEL = '-';

export type PartnerDiscountScopeFields = {
  partnerCompanyId: number;
  category: IUserDiscountCategory;
  classificationId?: number | null;
  method: IUserDiscountMethod;
  primaryCategory?: string | null;
  group?: string | null;
  range?: string | null;
  compareCondition: ICompareCondition;
};

/**
 * NULL 은 sentinel 로, 구분자·escape 문자는 escape 한다.
 * escape 하지 않으면 `group='a|b'` 가 인접 필드와 경계를 섞어 다른 scope 와 같은 키가 된다.
 * `\` 를 먼저 치환해야 `|` → `\|` 결과가 재차 escape 되지 않는다.
 */
function esc(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return NULL_SENTINEL;
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/**
 * SECTION 의 range 는 표기 흔들림(앞뒤 공백·유니코드 합성형)이 그대로 다른 scope 가 되지 않도록 정규화한다.
 *
 * **저장값·중복 검증·scopeKey 가 모두 이 함수를 통과한 같은 값을 써야 한다.** 저장만 원문으로 두면
 * `"1000"` 과 `" 1000 "` 이 `user_discount` 에는 둘 다 남으면서 이력 scopeKey 는 하나를 공유해,
 * 두 번째 생성이 첫 이력을 닫아버리고 활성 원본과 이력이 어긋난다.
 */
export function normalizeScopeRange(range: string | null | undefined): string | null {
  if (range === null || range === undefined) return null;
  const normalized = range.normalize('NFC').trim();
  return normalized.length === 0 ? null : normalized;
}

/**
 * scope 8필드 canonical key. history 구간·앵커 잠금의 단위.
 */
export function buildScopeKey(fields: PartnerDiscountScopeFields): string {
  return [
    SCOPE_KEY_PREFIX,
    esc(fields.partnerCompanyId),
    esc(fields.category),
    esc(fields.classificationId),
    esc(fields.method),
    esc(fields.primaryCategory),
    esc(fields.group),
    esc(normalizeScopeRange(fields.range)),
    esc(fields.compareCondition),
  ].join('|');
}

/**
 * scopeKey 보다 넓은 정책 대상 key — method · range · compareCondition 을 제외한다.
 *
 * BULK 와 SECTION 은 서로 다른 scopeKey 를 갖기 때문에, scopeKey 앵커만 잡으면 같은 대상에 대한
 * BULK·SECTION 동시 요청이 서로 다른 앵커를 잡고 둘 다 통과한다(현행 서비스의 상호배제 검증이 무력화).
 * 그래서 넓은 policyTargetKey 앵커를 먼저 잡는다.
 */
export function buildPolicyTargetKey(
  fields: Pick<PartnerDiscountScopeFields, 'partnerCompanyId' | 'category' | 'classificationId' | 'primaryCategory' | 'group'>,
): string {
  return [
    POLICY_TARGET_KEY_PREFIX,
    esc(fields.partnerCompanyId),
    esc(fields.category),
    esc(resolveTargetIdentifier(fields)),
  ].join('|');
}

/**
 * 분류별 대상 식별자. 분류가 쓰지 않는 필드는 키에서 배제해야 같은 대상이 항상 같은 키가 된다.
 */
function resolveTargetIdentifier(
  fields: Pick<PartnerDiscountScopeFields, 'category' | 'classificationId' | 'primaryCategory' | 'group'>,
): string | number | null {
  switch (fields.category) {
    case IUserDiscountCategory.PRODUCT_GROUP:
      return fields.group ?? null;
    case IUserDiscountCategory.BRAND:
      return fields.primaryCategory ?? null;
    case IUserDiscountCategory.CATEGORY:
      return fields.classificationId ?? null;
    default:
      return null;
  }
}
