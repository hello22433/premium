import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { IProductSettleMethod } from '../../product/interface/product.settle.method';
import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';
import { IPartnerSettleVatCalculationMode } from '../interface/partner.settle.source.type';
import { PricingProductSnapshot } from '../domain/partner.settle.pricing';
import { isSettlementEvent, ObservedEventKind, resolveSourceType } from '../domain/settle.source.type.mapping';
import { SubItemKeyUnresolvedError } from '../domain/settle.sub.item.key';
import { KstInstant } from '../domain/settle.time';
import { PartnerSettleFeatureFlag } from './partner.settle.feature.flag';
import { PartnerSettleLedgerService } from './partner.settle.ledger.service';

/**
 * producer 공통 진입점 (PR1B 명세 B14 · §4).
 *
 * 6종 훅(발송확정·쿠폰상태 배치·갤럭시아 일대사/push·스푼 push·SSG 교환확인·CS 폐기)이 전부 이 한
 * 지점을 통해 원장을 만든다. 훅마다 flag 검사·잠금 순서·sourceType 판정을 따로 쓰면 그중 하나가
 * 반드시 어긋난다.
 *
 * **flag off 는 완전 no-op 이다** — 잠금도 조회도 하지 않고 즉시 빠져나간다(§4.6 회귀 요건:
 * off 상태에서 기존 배치·push·CS 동작이 1비트도 바뀌지 않아야 한다).
 *
 * 호출부는 **원천 상태 갱신과 같은 트랜잭션** 안에서 부른다(§6.5). 트랜잭션이 갈리면 상태는 USED 인데
 * 원장이 없는 영구 미정산 창이 생긴다.
 */

export type SettlementContext = {
  provider: IPartnerCompanyType;
  partnerCompanyId: number;
  orderDeliveryId: number;
  /** 상품 `settleMethod`. 이 값이 sourceType 과 정산성을 결정한다(§4.2 D4) */
  settleMethod: IProductSettleMethod | null;
  /** `order_product_mapping` 불변 스냅샷 (live product 조인 금지) */
  snapshot: PricingProductSnapshot;
  /** 하위항목 키 입력 — 갤럭시아 giftKind/brandCode · 한국문화진흥 유효기간 */
  subItem: { giftKind?: string | null; brandCode?: string | null; snapshotProductExpireDay?: number | null };
  /** 거래 당시 VAT 정책. 협력사 정산 config 는 PR1D 소유라 그때까지는 호출부가 넘긴다 */
  vatCalculationMode?: IPartnerSettleVatCalculationMode;
};

export type SettlementEvent = {
  /** 훅이 감지한 사건 종류. sourceType 이 아니다 — 정산성 판정 입력이다 */
  kind: ObservedEventKind;
  idempotencyKey: string;
  /** NULL = 시각 복원 불가 → `TIME_UNRECOVERABLE` 격리 */
  occurredAt: KstInstant | null;
  /** NULL = 금액 복원 불가 → `PRICE_UNRECOVERABLE` 격리 */
  baseAmount: bigint | null;
  discountAmount?: bigint;
  galaxiaBarcodeLogId?: number | null;
  providerEvidenceRef?: string | null;
  providerEvidenceHash?: string | null;
  /** 자동 claim 한 orphan lane inbox row (claim CAS 성공 후에만 넘긴다) */
  orphanInboxRowId?: number | null;
  /** provider 정의 외 코드 — 금액 없이 `UNKNOWN_PROVIDER_EVENT` 로 격리한다 */
  unknownProviderEvent?: boolean;
  memo?: string | null;
};

export type SettlementCancellation = {
  kind: ObservedEventKind;
  reversesLedgerId: number;
  /** 취소 event 자기 멱등 base key. 원본 id suffix 는 원장 서비스가 붙인다 */
  baseIdempotencyKey: string;
  occurredAt: KstInstant;
  /** 부분취소 절대값. 미지정 = 잔여 전액 */
  cancelBaseAmount?: bigint | null;
  galaxiaBarcodeLogId?: number | null;
  providerEvidenceRef?: string | null;
  providerEvidenceHash?: string | null;
  memo?: string | null;
};

@Injectable()
export class PartnerSettleProducerService {
  private readonly logger = new Logger(PartnerSettleProducerService.name);

  constructor(
    private readonly featureFlag: PartnerSettleFeatureFlag,
    private readonly ledgerService: PartnerSettleLedgerService,
  ) {}

  /** 이 사건이 원장을 만들 사건인지. 훅이 inbox·orphan 처리 전에 미리 물어보는 용도다. */
  isSettlementTarget(context: SettlementContext, kind: ObservedEventKind): boolean {
    return this.featureFlag.isEnabledFor(context.provider) && isSettlementEvent(context.settleMethod, kind);
  }

  /** 정산 사건 1건 → 원장 append. flag off·비정산 사건이면 `null` 을 돌려주고 아무것도 하지 않는다. */
  async record(
    context: SettlementContext,
    event: SettlementEvent,
    manager?: EntityManager,
  ): Promise<PartnerSettleLedgerEntity | null> {
    if (!this.isSettlementTarget(context, event.kind)) return null;

    await this.ledgerService.lockForAppend(context.partnerCompanyId, context.orderDeliveryId, manager);

    return this.guardSubItem(context, event.idempotencyKey, () =>
      this.ledgerService.appendLedger({
        partnerCompanyId: context.partnerCompanyId,
        subItem: { provider: context.provider, ...context.subItem },
        sourceType: resolveSourceType(context.settleMethod as IProductSettleMethod),
        orderDeliveryId: context.orderDeliveryId,
        galaxiaBarcodeLogId: event.galaxiaBarcodeLogId ?? null,
        idempotencyKey: event.idempotencyKey,
        occurredAt: event.occurredAt,
        baseAmount: event.baseAmount,
        discountAmount: event.discountAmount,
        vatCalculationMode: context.vatCalculationMode ?? 'NONE',
        snapshot: context.snapshot,
        providerEvidenceRef: event.providerEvidenceRef,
        providerEvidenceHash: event.providerEvidenceHash,
        orphanInboxRowId: event.orphanInboxRowId ?? null,
        memo: event.memo,
        unknownProviderEvent: event.unknownProviderEvent,
      }),
    );
  }

  /** 취소·환불 → 역분개 append. 원본 조건 스냅샷을 반대 부호로 복제하며 재계산하지 않는다. */
  async recordCancellation(
    context: SettlementContext,
    cancellation: SettlementCancellation,
    manager?: EntityManager,
  ): Promise<PartnerSettleLedgerEntity | null> {
    if (!this.isSettlementTarget(context, cancellation.kind)) return null;

    await this.ledgerService.lockForAppend(context.partnerCompanyId, context.orderDeliveryId, manager);

    return this.ledgerService.appendReversal({
      reversesLedgerId: cancellation.reversesLedgerId,
      baseIdempotencyKey: cancellation.baseIdempotencyKey,
      occurredAt: cancellation.occurredAt,
      cancelBaseAmount: cancellation.cancelBaseAmount,
      galaxiaBarcodeLogId: cancellation.galaxiaBarcodeLogId ?? null,
      providerEvidenceRef: cancellation.providerEvidenceRef,
      providerEvidenceHash: cancellation.providerEvidenceHash,
      memo: cancellation.memo,
    }, manager);
  }

  /**
   * 취소 훅이 역분개 대상을 찾는다. 결과가 비면 원본 원장 부재(flag off 시 기록)이므로 취소 생략.
   * 트랜잭션 밖에서 불러도 안전하다 — 읽기 전용이고 잠금을 잡지 않는다.
   */
  findReversibleEntries(orderDeliveryId: number, manager?: EntityManager) {
    return this.ledgerService.findReversibleEntries(orderDeliveryId, manager);
  }

  /**
   * 미등록 하위항목은 원장을 만들지 않고 실패시킨다(§7 D6).
   *
   * `subItemKey` 는 원장 불변값이라 추정 매핑으로 넣으면 하위항목 귀속이 영구히 틀어진다. 원천 event 는
   * provider 쪽에 남아 재처리 가능하므로 유실이 아니다 — 매핑 확장은 운영 대응 항목이다.
   */
  private async guardSubItem<T>(
    context: SettlementContext,
    idempotencyKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SubItemKeyUnresolvedError) {
        this.logger.error(
          `정산 원장 미생성 — 하위항목 미등록: provider=${context.provider} ` +
            `orderDeliveryId=${context.orderDeliveryId} key=${idempotencyKey} (${error.message})`,
        );
      }
      throw error;
    }
  }
}
