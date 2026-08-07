import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, IsNull, Not, Repository } from 'typeorm';
import { PartnerSettleLedgerEntity } from '../../entity/partner.settle.ledger.entity';
import {
  IPartnerSettleLedgerStatus,
  IPartnerSettleReviewCode,
  IPartnerSettleSourceEventIdOrigin,
  IPartnerSettleSourceType,
  IPartnerSettleVatCalculationMode,
} from '../interface/partner.settle.source.type';
import {
  assertAggregateBound,
  calculatePartialReversal,
  calculateSettleAmounts,
  LEDGER_AMOUNT_MAX,
  LedgerAmountRangeError,
  reverseAmounts,
  SettleAmountBreakdown,
  sumBreakdowns,
} from '../domain/settle.amount';
import { buildReversalKey } from '../domain/settle.idempotency.key';
import { resolveSubItemKey, SubItemKeyInput } from '../domain/settle.sub.item.key';
import { KstInstant, toDbDateTimeString } from '../domain/settle.time';
import { PricingProductSnapshot } from '../domain/partner.settle.pricing';
import { PartnerSettlePricingResolverService } from './partner.settle.pricing.resolver.service';
import { duplicateKeyConstraint, insertRawRow, isDuplicateKeyError, RawRow } from './partner.settle.raw.insert';
import { assertInTransaction } from './partner.settle.transaction.guard';

/**
 * 정산 원장 append (정본 §5.1 · §6.4 · §6.5 · PR1B 명세 B10).
 *
 * 원장은 append-only SoT 다. 이 서비스는 **원천 상태 갱신과 같은 트랜잭션 안에서만** 불린다.
 * 트랜잭션이 갈리면 상태는 USED 인데 원장이 없는(=영구 미정산) 창이 생긴다. 이 전제는 주석이 아니라
 * `assertInTransaction()` 이 진입점마다 런타임에 강제한다 — 없으면 스스로 열지 않고 즉시 깨뜨린다.
 *
 * 잠금 순서는 전 producer 공통이다: `partner_discount_policy_epoch`(FOR SHARE) → `order_delivery`
 * (FOR UPDATE) → inbox → ledger. `lockForAppend()` 가 앞 두 단계를 한 지점에서 잡는다.
 * 데드락 재시도는 **트랜잭션 밖에서** `retryOnLockConflict` 로 감싼다.
 *
 * 설계상 지켜야 할 규칙 셋:
 * 1. **`occurredAt` 은 `toDbDateTimeString()` canonical 문자열로 저장한다.** TypeORM 은 datetime
 *    컬럼 값을 `Date` 로 정규화하는데 `Date` 는 밀리초까지라 `.123456` 이 `.123000` 으로 잘린다.
 *    그래서 INSERT 를 파라미터 바인딩 raw SQL 로 직접 쓴다(엔티티 insert 금지).
 * 2. **판정 실패는 throw 하지 않고 격리 row 로 남긴다.** throw 하면 같은 트랜잭션의 상태 전이까지
 *    롤백되어 배치가 그 발송건에서 영구히 막힌다.
 * 3. **역분개 누적은 부호 그대로 접는다**(`sumBreakdowns`). 항목별 절대값 차분은 할증
 *    (receiving 양수·vat 음수)에서 `giving − receiving + vat = feeTotal` 항등식을 깬다.
 */

/** 원장을 만들 수 없는 호출부 계약 위반. 격리(NEEDS_REVIEW)로 흡수하면 안 되는 것만 여기로 온다. */
export class LedgerInvariantError extends Error {}

/** 멱등 수렴으로 삼켜도 되는 유일한 UNIQUE. 나머지 충돌은 사건이 다른데 슬롯이 겹친 대사 오류다. */
const LEDGER_IDEMPOTENCY_CONSTRAINT = 'uk_partner_settle_ledger_idempotency';
const LEDGER_TRANSITION_CONSTRAINT = 'uk_partner_settle_ledger_transition';
const LEDGER_ORPHAN_SETTLEMENT_CONSTRAINT = 'uk_partner_settle_ledger_orphan_settlement';

type LedgerTransitionRef = {
  observationId: number;
  /** 같은 observation 안의 event 순번. 정상 감지 = 1 */
  sequenceNo: number;
  /** 같은 전이 내 역분개 allocation 순번. forward·단일 reversal = 1, multi reversal = 1..N */
  allocationNo: number;
  sourceEventIdOrigin: IPartnerSettleSourceEventIdOrigin;
};

export type LedgerAppendCommand = {
  partnerCompanyId: number;
  /** 하위항목 키 입력. 미등록 값은 `SubItemKeyUnresolvedError` 로 **원장 미생성 + 처리 실패**(§7 D6) */
  subItem: SubItemKeyInput;
  sourceType: IPartnerSettleSourceType;
  /** ADJUSTMENT(PR3) 외에는 필수 */
  orderDeliveryId: number | null;
  galaxiaBarcodeLogId?: number | null;
  /** 전이 단위 멱등키 — 반드시 `settle.idempotency.key.ts` 빌더로 만든 값 */
  idempotencyKey: string;
  /** 귀속 시각. NULL = 시각 복원 불가(`TIME_UNRECOVERABLE` 격리) */
  occurredAt: KstInstant | null;
  /** 정가/사용액. NULL = 금액 복원 불가(`PRICE_UNRECOVERABLE` 격리) */
  baseAmount: bigint | null;
  /** 할인금액 스냅샷(절대값) */
  discountAmount?: bigint;
  vatCalculationMode: IPartnerSettleVatCalculationMode;
  /** matcher 입력 — `order_product_mapping` 불변 스냅샷 (live product 조인 금지) */
  snapshot: PricingProductSnapshot;
  providerEvidenceRef?: string | null;
  providerEvidenceHash?: string | null;
  transition?: LedgerTransitionRef | null;
  /** 자동 claim 한 orphan lane inbox row */
  orphanInboxRowId?: number | null;
  /** 수동 orphan 승인 proposal id */
  manualLedgerProposalId?: number | null;
  memo?: string | null;
  /** provider 가 정의 외 코드를 보낸 경우 — 금액 없이 `UNKNOWN_PROVIDER_EVENT` 로 격리한다 */
  unknownProviderEvent?: boolean;
};

export type LedgerReversalCommand = {
  /** 역분개 대상 원본 원장 id */
  reversesLedgerId: number;
  /** 취소 event 자기 멱등 base key. 여기에 `:{reversesLedgerId}` 를 붙여 allocation 별로 가른다 */
  baseIdempotencyKey: string;
  /** 취소 시각 */
  occurredAt: KstInstant;
  /** 부분취소 baseAmount 절대값. 미지정 = 잔여 전액 취소 */
  cancelBaseAmount?: bigint | null;
  galaxiaBarcodeLogId?: number | null;
  providerEvidenceRef?: string | null;
  providerEvidenceHash?: string | null;
  transition?: LedgerTransitionRef | null;
  memo?: string | null;
  /** 수동 orphan 승인 proposal id */
  manualLedgerProposalId?: number | null;
};

type LedgerRow = RawRow;

@Injectable()
export class PartnerSettleLedgerService {
  private readonly logger = new Logger(PartnerSettleLedgerService.name);

  constructor(
    @InjectRepository(PartnerSettleLedgerEntity)
    private readonly ledgerRepository: Repository<PartnerSettleLedgerEntity>,
    private readonly pricingResolver: PartnerSettlePricingResolverService,
  ) {}
  /**
   * 수동 queryRunner 트랜잭션(CS execDiscard 등)에서 호출할 때 manager 를 넘기면
   * 그 manager 의 queryRunner 를 통해 같은 커넥션에서 잠금·조회·INSERT 가 실행된다.
   * CLS 경로(P1~P5)는 manager 를 넘기지 않으므로 기존 동작이 1비트도 바뀌지 않는다.
   */
  private repo(manager?: EntityManager): Repository<PartnerSettleLedgerEntity> {
    return manager ? manager.getRepository(PartnerSettleLedgerEntity) : this.ledgerRepository;
  }

  /**
   * 잠금 순서 1~2단계. producer 는 원천을 읽기 **전에** 이걸 먼저 부른다.
   *
   * 순서를 producer 마다 다르게 잡으면 일일 배치와 push 수신이 교차 데드락에 걸린다.
   */
  async lockForAppend(
    partnerCompanyId: number,
    orderDeliveryId: number | null,
    manager?: EntityManager,
  ): Promise<void> {
    // 트랜잭션이 없으면 raw FOR UPDATE 가 에러 없이 무력화된다(autocommit). 잠근 줄 알고 진행하는 게 최악이다.
    assertInTransaction(manager ?? this.ledgerRepository, '정산 원장 잠금(lockForAppend)');

    await this.pricingResolver.lockPolicyForRead(partnerCompanyId, manager);
    if (orderDeliveryId !== null) {
      await this.repo(manager).query('SELECT id FROM order_delivery WHERE id = ? FOR UPDATE', [orderDeliveryId]);
    }
  }

  /**
   * 원장 1건 append. 같은 멱등키가 이미 있으면 **기존 row 를 그대로 돌려준다**(중복 append 0).
   *
   * 재스캔·재시도·동시 poll 이 모두 이 경로로 들어오므로, 멱등이 아니면 같은 사건이 여러 번 정산된다.
   */
  async appendLedger(command: LedgerAppendCommand, manager?: EntityManager): Promise<PartnerSettleLedgerEntity> {
    assertInTransaction(manager ?? this.ledgerRepository, '정산 원장 append(appendLedger)');

    const existing = await this.findByIdempotencyKey(command.idempotencyKey, manager);
    if (existing) return existing;

    // 미등록 하위항목은 격리조차 못 한다(subItemKey NOT NULL·불변). 원장을 만들지 않고 실패시킨다.
    const subItemKey = resolveSubItemKey(command.subItem);
    const row = await this.buildAppendRow(command, subItemKey, manager);
    return this.insertRow(row, command.idempotencyKey, manager);
  }

  /**
   * 취소·환불 역분개. 원본 조건 스냅샷을 **반대 부호로 복제**하며 취소 시점 재계산을 하지 않는다.
   *
   * 부분취소는 §6.4 이중 불변식(base·settle 각각 잔여 소진)을 `calculatePartialReversal` 이 강제하고,
   * 마지막 취소가 잔여 전량을 소진해 모든 구성금액이 정확히 0 이 된다.
   */
  async appendReversal(command: LedgerReversalCommand, manager?: EntityManager): Promise<PartnerSettleLedgerEntity> {
    // 아래 pessimistic_write 는 비트랜잭션이면 TypeORM 이 쿼리를 거부한다. 그 전에 계약 위반으로 끊는다.
    assertInTransaction(manager ?? this.ledgerRepository, '정산 원장 역분개(appendReversal)');

    const idempotencyKey = buildReversalKey(command.baseIdempotencyKey, command.reversesLedgerId);

    const existing = await this.findByIdempotencyKey(idempotencyKey, manager);
    if (existing) return existing;

    // 원본을 잠근 뒤에 기존 역분개를 접어야 동시 취소 2건이 같은 잔여를 두 번 쓰지 않는다.
    const original = await this.repo(manager)
      .createQueryBuilder('ledger')
      .setLock('pessimistic_write')
      .where('ledger.id = :id', { id: command.reversesLedgerId })
      .getOne();

    if (!original) {
      throw new LedgerInvariantError(`역분개 대상 원장이 없다: ${command.reversesLedgerId}`);
    }
    if (original.status === 'NEEDS_REVIEW') {
      // 금액이 비어 있는 격리 row 는 상쇄할 대상이 없다. 해소(PR1C) 후에 취소가 반영된다.
      throw new LedgerInvariantError(`격리 상태 원장은 역분개 대상이 아니다: ${original.id}`);
    }
    if (original.reversesLedgerId !== null) {
      throw new LedgerInvariantError(`역분개 row 를 다시 역분개할 수 없다: ${original.id}`);
    }

    const priorReversals = await this.repo(manager).find({
      where: { reversesLedgerId: original.id },
    });
    const reversedTotals = sumBreakdowns(priorReversals.map(toBreakdown));
    assertAggregate('역분개 누적 baseAmount', reversedTotals.baseAmount);

    const originalAmounts = toBreakdown(original);
    const remainingBase = originalAmounts.baseAmount + reversedTotals.baseAmount;
    if (remainingBase === 0n) {
      throw new LedgerInvariantError(`이미 전액 역분개된 원장이다: ${original.id}`);
    }

    const amounts = this.calculateReversalAmounts(command, original, originalAmounts, reversedTotals);

    const row: LedgerRow = {
      ...this.commonColumns({
        partnerCompanyId: original.partnerCompanyId,
        subItemKey: original.subItemKey,
        sourceType: original.sourceType,
        orderDeliveryId: original.orderDeliveryId,
        galaxiaBarcodeLogId: command.galaxiaBarcodeLogId ?? null,
        idempotencyKey,
        occurredAt: command.occurredAt,
        vatCalculationMode: original.vatCalculationMode,
        providerEvidenceRef: command.providerEvidenceRef,
        providerEvidenceHash: command.providerEvidenceHash,
        transition: command.transition,
        // 음수 배분은 orphan 정산 UNIQUE 에서 제외된다(generated key 가 NULL). 원본만 ingress 를 점유한다.
        orphanInboxRowId: null,
        memo: command.memo,
        manualLedgerProposalId: command.manualLedgerProposalId ?? null,
      }),
      reverses_ledger_id: original.id,
      status: original.status,
      review_code: null,
      review_resolution: null,
      applied_price_percent: original.appliedPricePercent,
      applied_price_adjustment: original.appliedPriceAdjustment,
      applied_discount_history_id: original.appliedDiscountHistoryId,
      pricing_resolution: original.pricingResolution,
      ...amountColumns(amounts),
    };

    return this.insertRow(row, idempotencyKey, manager);
  }

  private calculateReversalAmounts(
    command: LedgerReversalCommand,
    original: PartnerSettleLedgerEntity,
    originalAmounts: SettleAmountBreakdown,
    reversedTotals: SettleAmountBreakdown,
  ): SettleAmountBreakdown {
    const cancelBase = command.cancelBaseAmount ?? null;
    // NORMAL/ON_HOLD 는 DB CHECK 상 조건 스냅샷이 채워져 있다. 비어 있으면 배분 기준이 없다는 뜻이라 멈춘다.
    if (original.appliedPricePercent === null || original.appliedPriceAdjustment === null) {
      throw new LedgerInvariantError(`조건 스냅샷이 없는 원장은 역분개할 수 없다: ${original.id}`);
    }

    try {
      // 전액취소 = 잔여 전량 반전. 개별 절사 합이 아니라 잔여를 통째로 뒤집어야 구성금액이 정확히 0 이 된다.
      if (cancelBase === null) {
        // 원본 + 역분개 누적(음수) = 잔여. 부호를 유지해야 항등식이 보존된다.
        return reverseAmounts(sumBreakdowns([originalAmounts, reversedTotals]));
      }

      return calculatePartialReversal({
        original: originalAmounts,
        cancelBaseAmount: cancelBase,
        reversedTotals,
        pricePercent: original.appliedPricePercent,
        priceAdjustment: original.appliedPriceAdjustment,
        vatCalculationMode: original.vatCalculationMode,
      });
    } catch (error) {
      if (error instanceof LedgerAmountRangeError) {
        // 과다취소·상한 초과는 사용자 입력 오류가 아니라 원천 대사 오류다. 422 로 끊고 부분 write 를 남기지 않는다.
        throw new UnprocessableEntityException(`정산 원장 역분개를 계산할 수 없습니다: ${error.message}`);
      }
      throw error;
    }
  }

  private async buildAppendRow(
    command: LedgerAppendCommand,
    subItemKey: string,
    manager?: EntityManager,
  ): Promise<LedgerRow> {
    const common = this.commonColumns({
      partnerCompanyId: command.partnerCompanyId,
      subItemKey,
      sourceType: command.sourceType,
      orderDeliveryId: command.orderDeliveryId,
      galaxiaBarcodeLogId: command.galaxiaBarcodeLogId ?? null,
      idempotencyKey: command.idempotencyKey,
      occurredAt: command.occurredAt,
      vatCalculationMode: command.vatCalculationMode,
      providerEvidenceRef: command.providerEvidenceRef,
      providerEvidenceHash: command.providerEvidenceHash,
      transition: command.transition,
      orphanInboxRowId: command.orphanInboxRowId ?? null,
      memo: command.memo,
      manualLedgerProposalId: command.manualLedgerProposalId ?? null,
    });

    // ① provider 정의 외 코드 — 사건은 남기되 금액을 만들지 않는다.
    if (command.unknownProviderEvent) {
      return { ...common, ...isolationColumns('UNKNOWN_PROVIDER_EVENT'), base_amount: null };
    }

    // ② 시각 복원 불가 — 귀속 월을 못 정한다. 금액은 보존한다(해소 시 시각만 채운다).
    if (command.occurredAt === null) {
      if (command.baseAmount === null) {
        throw new LedgerInvariantError('시각·금액이 모두 없는 event 는 UNKNOWN_PROVIDER_EVENT 로 격리한다');
      }
      this.assertBaseAmountBound(command.baseAmount);
      return {
        ...common,
        ...isolationColumns('TIME_UNRECOVERABLE'),
        base_amount: String(command.baseAmount),
      };
    }

    // ③ 금액 복원 불가.
    if (command.baseAmount === null) {
      return { ...common, ...isolationColumns('PRICE_UNRECOVERABLE'), base_amount: null };
    }

    this.assertBaseAmountBound(command.baseAmount);

    const pricing = await this.pricingResolver.resolveAt(
      command.partnerCompanyId,
      command.occurredAt.date,
      command.snapshot,
      manager,
    );

    // ④ 이력 손상 — 현재값 fallback 은 틀린 금액을 확정시킨다. 금액을 비우고 격리한다.
    if (pricing.status === 'NEEDS_REVIEW') {
      this.logger.warn(
        `정산 원장 격리: key=${command.idempotencyKey} code=${pricing.reviewCode} reason=${pricing.reason}`,
      );
      return {
        ...common,
        ...isolationColumns(pricing.reviewCode),
        // PRICE_UNRECOVERABLE 은 base 를 신뢰할 수 없다는 판정이므로 스냅샷 금액을 싣지 않는다.
        base_amount: pricing.reviewCode === 'PRICE_UNRECOVERABLE' ? null : String(command.baseAmount),
      };
    }

    let amounts: SettleAmountBreakdown;
    try {
      amounts = calculateSettleAmounts({
        baseAmount: command.baseAmount,
        discountAmount: command.discountAmount ?? 0n,
        pricePercent: pricing.pricePercent,
        priceAdjustment: pricing.priceAdjustment,
        vatCalculationMode: command.vatCalculationMode,
      });
    } catch (error) {
      if (error instanceof LedgerAmountRangeError) {
        throw new UnprocessableEntityException(`정산 금액을 계산할 수 없습니다: ${error.message}`);
      }
      throw error;
    }

    return {
      ...common,
      reverses_ledger_id: null,
      status: 'NORMAL' satisfies IPartnerSettleLedgerStatus,
      review_code: null,
      review_resolution: null,
      applied_price_percent: String(pricing.pricePercent),
      applied_price_adjustment: pricing.priceAdjustment,
      applied_discount_history_id: pricing.appliedDiscountHistoryId,
      pricing_resolution: pricing.pricingResolution,
      ...amountColumns(amounts),
    };
  }

  /** 단건 상한(57차-H3 ①). 원천이 준 base 가 범위 밖이면 계산 자체가 무의미하므로 400 이다. */
  private assertBaseAmountBound(baseAmount: bigint): void {
    const abs = baseAmount < 0n ? -baseAmount : baseAmount;
    if (abs > LEDGER_AMOUNT_MAX) {
      throw new BadRequestException(`정산 원장 baseAmount 가 단건 상한을 초과했습니다: ${baseAmount}`);
    }
  }

  private commonColumns(input: {
    partnerCompanyId: number;
    subItemKey: string;
    sourceType: IPartnerSettleSourceType;
    orderDeliveryId: number | null;
    galaxiaBarcodeLogId: number | null;
    idempotencyKey: string;
    occurredAt: KstInstant | null;
    vatCalculationMode: IPartnerSettleVatCalculationMode;
    providerEvidenceRef?: string | null;
    providerEvidenceHash?: string | null;
    transition?: LedgerTransitionRef | null;
    orphanInboxRowId: number | null;
    manualLedgerProposalId: number | null;
    memo?: string | null;
  }): LedgerRow {
    return {
      partner_company_id: input.partnerCompanyId,
      sub_item_key: input.subItemKey,
      source_type: input.sourceType,
      order_delivery_id: input.orderDeliveryId,
      galaxia_barcode_log_id: input.galaxiaBarcodeLogId,
      idempotency_key: input.idempotencyKey,
      // canonical 문자열. Date 로 넘기면 마이크로초가 잘린다.
      occurred_at: input.occurredAt === null ? null : toDbDateTimeString(input.occurredAt),
      vat_calculation_mode: input.vatCalculationMode,
      provider_evidence_ref: input.providerEvidenceRef ?? null,
      provider_evidence_hash: input.providerEvidenceHash ?? null,
      transition_observation_id: input.transition?.observationId ?? null,
      transition_sequence_no: input.transition?.sequenceNo ?? null,
      transition_allocation_no: input.transition?.allocationNo ?? null,
      source_event_id_origin: input.transition?.sourceEventIdOrigin ?? null,
      orphan_inbox_row_id: input.orphanInboxRowId,
      memo: input.memo ?? null,
      manual_ledger_proposal_id: input.manualLedgerProposalId,
      settle_batch_id: null,
    };
  }

  /** append 결과는 항상 멱등키로 재조회한다 — 신규 INSERT 든 **멱등키** 충돌이든 답은 같은 row 다. */
  private async insertRow(
    row: LedgerRow,
    idempotencyKey: string,
    manager?: EntityManager,
  ): Promise<PartnerSettleLedgerEntity> {
    try {
      await insertRawRow(this.repo(manager), 'partner_settle_ledger', row, {
        idempotentConstraints: [LEDGER_IDEMPOTENCY_CONSTRAINT],
      });
    } catch (error) {
      this.rethrowInsertConflict(error, idempotencyKey);
    }

    const inserted = await this.findByIdempotencyKey(idempotencyKey, manager);
    if (!inserted) {
      throw new InternalServerErrorException('정산 원장 append 결과를 다시 읽지 못했습니다.');
    }
    return inserted;
  }

  /**
   * 멱등키 외 UNIQUE 충돌은 **다른 사건이 같은 슬롯을 노린 대사 오류**다.
   *
   * 멱등키로 재조회해봐야 없으므로 원인 정보 없는 500 만 남는다. 어느 제약이 걸렸는지 남기고,
   * 원본 driver 에러를 `cause` 로 보존한 422 로 끊는다(운영자 대사 대상).
   */
  private rethrowInsertConflict(error: unknown, idempotencyKey: string): never {
    if (isDuplicateKeyError(error)) {
      const constraint = duplicateKeyConstraint(error);

      if (constraint === LEDGER_TRANSITION_CONSTRAINT) {
        throw new UnprocessableEntityException(
          `같은 관측 전이 순번에 이미 원장이 있습니다(key=${idempotencyKey}). 멱등키와 전이 순번이 어긋납니다.`,
          { cause: error },
        );
      }
      if (constraint === LEDGER_ORPHAN_SETTLEMENT_CONSTRAINT) {
        throw new UnprocessableEntityException(
          `이미 정산된 orphan ingress 입니다(key=${idempotencyKey}). 같은 inbox row 를 두 번 정산할 수 없습니다.`,
          { cause: error },
        );
      }
    }

    throw error;
  }

  private findByIdempotencyKey(
    idempotencyKey: string,
    manager?: EntityManager,
  ): Promise<PartnerSettleLedgerEntity | null> {
    return this.repo(manager).findOne({ where: { idempotencyKey } });
  }

  /**
   * 취소/역분개 대상 원장을 찾는다 — `reverses_ledger_id IS NULL` 이고 `NEEDS_REVIEW` 가 아닌 row.
   *
   * 호출부(P4 L2 · P2 CANCEL · P6 CS 폐기)가 이 결과의 `id` 를 `recordCancellation.reversesLedgerId` 로 넘긴다.
   * 결과가 비어 있으면 "원본 원장이 없다"(flag off 시 기록된 사용 건, 또는 이미 전액 역분개)이므로 취소 생략.
   */
  async findReversibleEntries(orderDeliveryId: number, manager?: EntityManager): Promise<PartnerSettleLedgerEntity[]> {
    return this.repo(manager).find({
      where: {
        orderDeliveryId,
        reversesLedgerId: IsNull(),
        status: Not(In(['NEEDS_REVIEW'] satisfies IPartnerSettleLedgerStatus[])),
      },
      order: { id: 'ASC' },
    });
  }
}

function isolationColumns(reviewCode: IPartnerSettleReviewCode): LedgerRow {
  return {
    reverses_ledger_id: null,
    status: 'NEEDS_REVIEW' satisfies IPartnerSettleLedgerStatus,
    review_code: reviewCode,
    review_resolution: 'PENDING',
    applied_price_percent: null,
    applied_price_adjustment: null,
    applied_discount_history_id: null,
    pricing_resolution: null,
    settle_amount: null,
    // 격리 동안은 구성금액을 만들지 않는다. 0 이 아닌 값을 넣으면 미해소 상태로 여신 표에 섞인다.
    discount_amount: '0',
    receiving_commission_amount: '0',
    giving_commission_amount: '0',
    vat_amount: '0',
    fee_total_amount: '0',
  };
}

function amountColumns(amounts: SettleAmountBreakdown): LedgerRow {
  return {
    base_amount: String(amounts.baseAmount),
    discount_amount: String(amounts.discountAmount),
    receiving_commission_amount: String(amounts.receivingCommissionAmount),
    giving_commission_amount: String(amounts.givingCommissionAmount),
    vat_amount: String(amounts.vatAmount),
    fee_total_amount: String(amounts.feeTotalAmount),
    settle_amount: String(amounts.settleAmount),
  };
}

/** TypeORM 은 bigint 를 문자열로 돌려준다. `number` 로 파싱하면 2^53 이후 정확도를 잃는다. */
function toBreakdown(row: PartnerSettleLedgerEntity): SettleAmountBreakdown {
  return {
    baseAmount: BigInt(row.baseAmount ?? '0'),
    discountAmount: BigInt(row.discountAmount ?? '0'),
    receivingCommissionAmount: BigInt(row.receivingCommissionAmount ?? '0'),
    givingCommissionAmount: BigInt(row.givingCommissionAmount ?? '0'),
    vatAmount: BigInt(row.vatAmount ?? '0'),
    feeTotalAmount: BigInt(row.feeTotalAmount ?? '0'),
    settleAmount: BigInt(row.settleAmount ?? '0'),
  };
}

function assertAggregate(label: string, value: bigint): void {
  try {
    assertAggregateBound(label, value);
  } catch (error) {
    if (error instanceof LedgerAmountRangeError) {
      throw new UnprocessableEntityException(error.message);
    }
    throw error;
  }
}
