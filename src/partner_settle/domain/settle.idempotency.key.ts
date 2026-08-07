import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { IPartnerSettleSourceType } from '../interface/partner.settle.source.type';

/**
 * 원장 멱등키 (정본 §5.1 「멱등 키 규칙」).
 *
 * 같은 발송건에 원장 row 가 여러 개 생긴다(교환 `+X` → 취소 `−X` → 재사용 `+X`). 따라서
 * `(sourceType, orderDeliveryId)` 단순 unique 는 쓸 수 없고 **전이 단위** 키를 쓴다.
 *
 * 키 문자열은 **여기서만** 만든다. 호출부가 직접 조립하면 provider 값이 예약 namespace 를
 * 침범해(예: 운영자 임의 ID 를 provider 키처럼 저장) 서로 다른 사건이 UNIQUE 에 흡수된다.
 */

/** 서버만 발급하는 namespace. provider 원천값이 이 접두어를 갖는 것은 오염이다 (56차-H2). */
const RESERVED_PREFIXES = ['MANUAL_RESOLUTION:', 'MANUAL_LEDGER:', 'ADJ:PROPOSAL:', 'PAYMENT_VARIANCE:'];

export class SettleIdempotencyKeyError extends Error {}

/** 발행분 — 발송건당 1회. */
export function buildIssuanceKey(orderDeliveryId: number): string {
  return `ISS:${assertPositiveId('orderDeliveryId', orderDeliveryId)}`;
}

/** 사용분 — 갤럭시아 일대사 로그 1건당 1회(시각 완비 자동 원장). */
export function buildUsageKey(galaxiaBarcodeLogId: number): string {
  return `USE:${assertPositiveId('galaxiaBarcodeLogId', galaxiaBarcodeLogId)}`;
}

/**
 * 교환분·CS — provider 증적으로 검증된 불변 전이 ID.
 * provider·sourceType namespace 로 협력사 교차 ID 충돌을 막는다.
 */
export function buildProviderTransitionKey(
  provider: IPartnerCompanyType,
  sourceType: IPartnerSettleSourceType,
  sourceEventId: string,
): string {
  const normalized = (sourceEventId ?? '').trim();
  if (normalized.length === 0) {
    throw new SettleIdempotencyKeyError('sourceEventId 가 비어 있다 — 증적 없는 전이는 UNRESOLVED 로 보관한다');
  }
  for (const reserved of RESERVED_PREFIXES) {
    if (normalized.startsWith(reserved)) {
      throw new SettleIdempotencyKeyError(`provider 원천 ID 가 서버 예약 namespace 를 침범했다: ${normalized}`);
    }
  }
  return `EXC:${provider}:${sourceType}:${normalized}`;
}

/**
 * 역분개 row 는 base key 뒤에 `:{reversesLedgerId}` 를 **반드시** 붙인다(단일 원본이어도 필수).
 * 하나의 환불이 여러 원본을 걸치면 allocation 마다 자기 suffix 로 갈려 UNIQUE 충돌이 없다.
 */
export function buildReversalKey(baseKey: string, reversesLedgerId: number): string {
  return `${baseKey}:${assertPositiveId('reversesLedgerId', reversesLedgerId)}`;
}
/**
 * 수동 전이 해소 allocation 멱등키. 하나의 resolution 이 여러 ledger row 를 만들 수 있으므로 순번을 포함한다.
 */
export function buildManualResolutionKey(resolutionId: number, sequenceNo: number): string {
  return (
    `MANUAL_RESOLUTION:${assertPositiveId('resolutionId', resolutionId)}:` + assertPositiveId('sequenceNo', sequenceNo)
  );
}

function assertPositiveId(label: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SettleIdempotencyKeyError(`${label} 가 유효한 id 가 아니다: ${value}`);
  }
  return value;
}

/** 미복원 관측의 영구 identity 접두 (정본 §5.15.8). */
export function buildUnresolvedBaseKey(
  provider: IPartnerCompanyType,
  orderDeliveryId: number,
  sourceType: IPartnerSettleSourceType,
): string {
  return `UNRES:${provider}:${assertPositiveId('orderDeliveryId', orderDeliveryId)}:${sourceType}`;
}

/** snapshot-only provider 의 evidenceKey — inbox row id 가 영속 ingestion identity 다. */
export function buildInboxEvidenceKey(inboxRowId: number): string {
  return `INBOX:${assertPositiveId('inboxRowId', inboxRowId)}`;
}

/** 정상 감지 관측의 observationKey 는 ledger `EXC:` 멱등키와 identity 가 같다(generation 덧붙임 금지). */
export const buildProviderObservationKey = buildProviderTransitionKey;
