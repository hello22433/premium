import { ConflictException, Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { PinIssueDedupEntity } from '../../entity/pin.issue.dedup.entity';
import { SsgIssueLogEntity } from '../../entity/ssg.issue.log.entity';
import { PinIssueCommandEntity } from '../../entity/pin.issue.command.entity';
import { IsNull, QueryFailedError, Repository } from 'typeorm';
import {
  hasConsumedSsgIssueAuthority,
  PinIssueCommandAuthority,
} from '../../delivery/application/pin-issue-command.service';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { ICulture } from '../interface/culture';
import { IGalaxia } from '../interface/galaxia';
import { IGsmbiz } from '../interface/gsmbiz';
import { IGiftiel } from '../interface/giftiel';
import { IGiftiShow } from '../interface/giftishow';
import { IDaou } from '../interface/daou';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { GalaxiaBarcodeLogEntity } from '../../entity/galaxia.barcode.log.entity';
import { GiftielExchangeHistoryEntity } from '../../entity/giftiel.exchange.history.entity';
import { ISsgCheckOut, ISsgIssue, SsgPinResolution, SsgPinVerdict } from '../interface/ssg.issue';
import {
  SSG_AUTORESOLVE_PHASE,
  SsgAutoResolveCapability,
  SsgIssueOrdinal,
  SsgOrdinal2Evidence,
  aggregateSsgPinResolutions,
  canExecuteOrdinal,
} from '../domain/ssg.autoresolve.policy';
import { SsgAutoResolveConfig } from './ssg.autoresolve.config';
import {
  SsgIssueAlreadyConfirmedError,
  SsgIssueAttemptAlreadyActiveError,
  SsgIssueLogKeyCollisionError,
  SsgIssueRejectedError,
  SsgIssueUnknownError,
  SsgAutoResolveBlockedError,
} from '../infra/ssg.issue';
import { SsgInsertStateService, SsgAttemptPayload } from '../../delivery/application/ssg-insert-state.service';
import { MarkAttemptedResult, SsgInsertState } from '../../delivery/interface/ssg.insert.state';
import { SsgOrphanResolveOutcome } from '../interface/ssg.orphan.resolve';
import { Propagation, runInTransaction, Transactional } from 'typeorm-transactional';
import { orderBarcodeGenerate } from '../../order/domain/order.code.generate';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { SsgResendDeductPendingEntity } from '../../entity/ssg.resend.deduct.pending.entity';
import { SsgTransactionId } from '../domain/ssg.transaction.id';
import { systemFromPhoneNumber, ssgIssueUserName } from '../../const';
import { smsSsgTemplate } from '../../delivery/domain/sms.ssg.template';
import { addDays, format, subDays } from 'date-fns';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { UNSENDABLE_COUPON_STATUSES } from '../../delivery/interface/order.delivery.mutation.claim';
import { CancelCouponResDto } from '../api/CancelCouponResDto';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { parseDateString, isExpiredYMD, formatDateYMD } from '../../util/date.util';
import { applyReplaceCharacters } from '../../common/utils/replace-characters.util';
import { resolveGalaxiaUsage } from '../../common/utils/galaxia.usage.util';
import { sleep } from '../../util/time.util';
import { PartnerSettleFeatureFlag } from '../../partner_settle/application/partner.settle.feature.flag';
import { PartnerSettleProducerService } from '../../partner_settle/application/partner.settle.producer.service';
import { buildSettlementContext } from '../../partner_settle/application/partner.settle.context.builder';
import { buildIssuanceKey, buildProviderTransitionKey } from '../../partner_settle/domain/settle.idempotency.key';
import { fromDate } from '../../partner_settle/domain/settle.time';

/**
 * issue() 결과 — 배치 재발송 선차감 정합용.
 * ssgNewIssue=false(기존/후보 PIN 재사용)면 caller 는 선차감 행사를 역복원해야 한다(이중차감 방지).
 */
export interface PartnerIssueResult {
  /** SSG 신규 INSERT 로 전달된 ssgEvent 를 실제 차감·사용했는지. 재사용/비-SSG 는 false. */
  ssgNewIssue: boolean;
  /** 실제 PIN 이 귀속된 SSG 행사 id. 재사용 시 후보/기존 행사 id, 신규 시 ssgEvent.id, 미상 null. */
  ssgEventId: number | null;
  /** PIN_INVENTORY 재고형 할당 시 item ID (비-재고형은 undefined) */
  inventoryPinItemId?: string;
}

/** 후보 1건 판정 결과 + 관측용 원시 신호 (EP-P30 §5-2). */
export interface SsgCandidateVerdict {
  resolution: SsgPinResolution;
  tryYn: string | null;
  resultCd: string | null;
}

/**
 * 발송건 단위 판정 결과 (EP-P30 §5-3-1). **부작용 0** — durable 쓰기도 메모리 entity 변경도 없다.
 *
 * `hasAnyAttempt` 는 tombstone 포함 전체 행 기준이고, 후보 판정은 활성 행(`superseded_at IS NULL`)
 * 기준이다. 이 구분을 빼면 tombstone 된 발송건이 "시도한 적 없음"으로 오판된다.
 */
export interface SsgDeferredClassification {
  resolution: SsgPinResolution;
  confirmedCandidate?: SsgIssueLogEntity;
  hasAnyAttempt: boolean;
  activeCandidateCount: number;
  /** 관측용 후보별 원시 신호. 후보 0건(NOT_ATTEMPTED·tombstone-only)이면 빈 배열이다. */
  verdicts: Array<SsgCandidateVerdict & { candidate: SsgIssueLogEntity }>;
}

@Injectable()
export class PartnerCompanyExternService {
  constructor(
    @Inject('IGalaxia')
    private galaxia: IGalaxia,
    @Inject('IGsmbiz')
    private gsmbiz: IGsmbiz,
    @Inject('IGiftiel')
    private giftiel: IGiftiel,
    @Inject('IGiftiShow')
    private giftiShow: IGiftiShow,
    @Inject('ICulture')
    private culture: ICulture,
    @Inject('ISsgIssue')
    private ssgIssue: ISsgIssue,
    @Inject('IDaou')
    private daou: IDaou,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(PartnerCompanyExternHistoryEntity)
    private partnerCompanyExternHistoryRepository: Repository<PartnerCompanyExternHistoryEntity>,
    @InjectRepository(PartnerCompanyEntity)
    private partnerCompanyRepository: Repository<PartnerCompanyEntity>,
    @InjectRepository(PinIssueDedupEntity)
    private pinIssueDedupRepository: Repository<PinIssueDedupEntity>,
    @InjectRepository(SsgIssueLogEntity)
    private ssgIssueLogRepository: Repository<SsgIssueLogEntity>,
    @InjectRepository(PinIssueCommandEntity)
    private readonly pinIssueCommandRepository: Repository<PinIssueCommandEntity>,
    @InjectRepository(GiftielExchangeHistoryEntity)
    private giftielExchangeHistoryRepository: Repository<GiftielExchangeHistoryEntity>,
    @InjectRepository(GalaxiaBarcodeLogEntity)
    private galaxiaBarcodeLogRepository: Repository<GalaxiaBarcodeLogEntity>,
    private cryptoCipher: CryptoCipher,
    private ssgInsertStateService: SsgInsertStateService,
    @InjectRepository(SsgResendDeductPendingEntity)
    private resendDeductPendingRepository: Repository<SsgResendDeductPendingEntity>,
    private readonly settleFlag: PartnerSettleFeatureFlag,
    private readonly settleProducer: PartnerSettleProducerService,
    private readonly autoResolveConfig: SsgAutoResolveConfig,
  ) {}

  private logger = new Logger('PARTNER_COMPANY_EXTERN');

  // SSG API 동시 호출 방지를 위한 Mutex (한 번에 1개씩만 실행)
  private ssgApiMutex: Promise<void> = Promise.resolve();

  /**
   * SSG API 호출을 순차적으로 실행하기 위한 래퍼
   * 여러 곳에서 동시에 SSG API를 호출해도 한 번에 1개씩만 실행됨
   */
  private async withSsgMutex<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const waitForPrevious = this.ssgApiMutex;
    this.ssgApiMutex = new Promise<void>((resolve) => {
      release = resolve;
    });

    await waitForPrevious;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  private async assertConsumedSsgIssueAuthority(authority: PinIssueCommandAuthority | undefined): Promise<void> {
    if (!authority) {
      throw new InternalServerErrorException('SSG INSERT authority is required.');
    }

    const command = await this.pinIssueCommandRepository.findOne({
      where: {
        id: authority.commandId,
        ownerToken: authority.ownerToken,
        generation: authority.generation,
        workflowVersion: authority.workflowVersion,
      },
    });
    if (!hasConsumedSsgIssueAuthority(command)) {
      throw new InternalServerErrorException(`SSG INSERT authority is stale. commandId=${authority.commandId}`);
    }
  }

  private async checkSsgWithRetry(params: { eventNo: string; eventSeq: number; vno: string }): Promise<ISsgCheckOut> {
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.ssgIssue.check(params);
      } catch (e) {
        lastError = e;
        if (attempt < maxAttempts) {
          this.logger.warn(
            `[SSG] check() 실패, ${attempt}차 재시도 예정 (${attempt}/${maxAttempts}): ${e instanceof Error ? e.message : e}`,
          );
          await sleep(1000 * attempt);
        }
      }
    }
    throw lastError;
  }

  /**
   * 후보 1건 판정 (EP-P30 §5-2). **부작용 0** — 조회만 한다.
   *
   * ```
   * [1] 등록 여부 — GetSsgTry / cust_info — 지연 없음 — 재발급 판단의 유일 근거
   *     SsgTryError(호출·파싱 실패, tryYn 이 'Y'·'N' 이 아님) → LOOKUP_FAILED
   *     tryYn='N' → NOT_ISSUED (cust_info 에 없음이 확정)
   *     tryYn='Y' → [2]. 이 시점부터 재발급 영구 금지
   * [2] 사용 가능 여부 — GetSsgStatus / cust_info_result — 재사용 판단만
   *     resultCd ∈ {0100,0200,0400} → CONFIRMED
   *     그 외 resultCd            → REGISTERED_UNSENDABLE (운영 확인, 재조회 대상 아님)
   *     throw/timeout/파싱 불가    → LOOKUP_FAILED
   * ```
   *
   * 종전 구현은 `!== 'Y'` 로 위 세 가지를 전부 `UNKNOWN` 으로 접어 영구 동결을 만들었다.
   * `tryYn` 정확값 계약은 infra(`ssg.issue.ts` getTry)가 집행한다 — 비정상 값은 SsgTryError 다(§5-2-1).
   */
  private async classifySsgPinDetailed(params: {
    eventNo: string;
    eventSeq: number | null;
    personalCode: string;
  }): Promise<SsgCandidateVerdict> {
    let tryYn: string | null;
    try {
      const tryOut = await this.ssgIssue.getTry({ vno: params.personalCode });
      tryYn = tryOut?.response?.value?.[0]?.tryYn?.[0] ?? null;
    } catch {
      return { resolution: SsgPinResolution.LOOKUP_FAILED, tryYn: null, resultCd: null };
    }
    if (tryYn !== 'Y' && tryYn !== 'N') {
      // infra 계약상 도달 불가(SsgTryError 로 throw). 계약이 회귀로 깨져도 부재로 오판하지 않는다.
      return { resolution: SsgPinResolution.LOOKUP_FAILED, tryYn: null, resultCd: null };
    }
    if (tryYn === 'N') {
      return { resolution: SsgPinResolution.NOT_ISSUED, tryYn, resultCd: null };
    }
    if (params.eventSeq === null) {
      // legacy 후보 — check 파라미터가 없어 사용 가능 여부를 확인할 수단이 없다. 등록은 됐으므로
      // 재발급은 금지하고 운영 확인으로 보낸다.
      return { resolution: SsgPinResolution.UNKNOWN, tryYn, resultCd: null };
    }

    let resultCd: string | null;
    try {
      const checkOut = await this.checkSsgWithRetry({
        eventNo: params.eventNo,
        eventSeq: params.eventSeq,
        vno: params.personalCode,
      });
      resultCd = checkOut?.response?.value?.[0]?.resultCd?.[0] ?? null;
    } catch {
      return { resolution: SsgPinResolution.LOOKUP_FAILED, tryYn, resultCd: null };
    }
    return {
      resolution: this.isSsgSendableResult(resultCd ?? undefined)
        ? SsgPinResolution.CONFIRMED
        : SsgPinResolution.REGISTERED_UNSENDABLE,
      tryYn,
      resultCd,
    };
  }

  private async classifySsgPin(params: {
    eventNo: string;
    eventSeq: number | null;
    personalCode: string;
  }): Promise<SsgPinResolution> {
    return (await this.classifySsgPinDetailed(params)).resolution;
  }

  /** 후보별 판정 + 집계 (§5-3). 부작용 0. */
  private async resolveSsgPinCandidates(candidates: SsgIssueLogEntity[]): Promise<{
    resolution: SsgPinResolution;
    confirmedCandidate?: SsgIssueLogEntity;
    verdicts: Array<SsgCandidateVerdict & { candidate: SsgIssueLogEntity }>;
  }> {
    const verdicts = await Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        ...(await this.classifySsgPinDetailed({
          eventNo: candidate.eventNo,
          eventSeq: candidate.eventSeq,
          personalCode: candidate.personalCode,
        })),
      })),
    );
    return { ...aggregateSsgPinResolutions(verdicts), verdicts };
  }

  /**
   * ssg_issue_log 후보(cust_info 등록 확인된 PIN)를 재사용한다: 선택 후보의 PIN 을 메모리 엔티티에 반영하고
   * state CONFIRMED + order_delivery PIN 컴럼을 best-effort 로 durable 동기화(markConfirmed)한다.
   * 발송은 메모리 엔티티 기준이므로 markConfirmed 가 state 가드로 skip 되어도 재사용 PIN 으로 정상 발송된다.
   *
   * EP-P30 §6-B-2 — **이것이 판정의 부작용 부분**이다. 판정(`classifyDeferredSsgIssue`)과 분리돼
   * 있어, 호출자는 delivery claim 재획득(P1)에 성공한 뒤에만 이걸 부른다.
   */
  async applyConfirmedCandidate(orderDelivery: OrderDeliveryEntity, candidate: SsgIssueLogEntity): Promise<void> {
    orderDelivery.barCode = candidate.barCode;
    orderDelivery.personalCode = candidate.personalCode;
    orderDelivery.ssgTransactionId = candidate.ssgTransactionId;
    orderDelivery.couponNum = candidate.couponNum;
    orderDelivery.expireAt = candidate.expireAt;
    orderDelivery.encourageAt = candidate.encourageAt;
    // PIN 과 행사 귀속(ssgEventId)을 메모리에 함께 반영. durable 반영은 markConfirmed 의 REQUIRES_NEW 에서
    // PIN 과 같은 트랜잭션으로 처리한다(귀속 분리 방지). outer REQUIRED tx 에서 order_delivery 를 직접 update 하면
    // markConfirmed(REQUIRES_NEW)와 동일 row 락 충돌로 self-deadlock 이 나므로 outer-tx update 는 하지 않는다.
    if (candidate.ssgEventId != null) {
      orderDelivery.ssgEventId = candidate.ssgEventId;
    }
    if (candidate.ssgTransactionId) {
      await this.ssgInsertStateService.markConfirmed(orderDelivery.id, {
        barCode: candidate.barCode,
        personalCode: candidate.personalCode,
        ssgTransactionId: candidate.ssgTransactionId,
        couponNum: candidate.couponNum,
        expireAt: candidate.expireAt,
        encourageAt: candidate.encourageAt,
        ssgEventId: candidate.ssgEventId,
      });
    }
  }

  private isSsgSendableResult(resultCd: string | undefined): boolean {
    return resultCd === '0100' || resultCd === '0200' || resultCd === '0400';
  }

  /**
   * 재발송 경로의 기존 PIN 판정. 순수 조회다.
   *
   * `NOT_ISSUED`·`LOOKUP_FAILED` 등 미등록·미확정은 **정상 반환하지 않는다**(§6-B-3).
   * 재발송 경로는 command 권한·ordinal 증인이 없어 신규 INSERT 를 승인할 근거가 없으므로,
   * 재사용(`CONFIRMED`)만 통과시키고 나머지는 보류로 보낸다.
   */
  async classifySsgResendPin(orderDeliveryId: number, personalCode: string): Promise<SsgPinVerdict> {
    const candidates = await this.findActiveSsgCandidates(orderDeliveryId);
    const matching = candidates.filter((candidate) => candidate.personalCode === personalCode);
    const { resolution } = await this.resolveSsgPinCandidates(matching);

    if (resolution === SsgPinResolution.CONFIRMED) return SsgPinVerdict.REGISTERED;
    throw new SsgIssueUnknownError(
      `SSG PIN 재사용 불가 판정(${resolution}) — 재발송 보류. orderDeliveryId=${orderDeliveryId}`,
    );
  }

  /** 활성 후보 — 어떤 PIN 을 조회·재사용할가 (tombstone 제외, §6-D). */
  private async findActiveSsgCandidates(orderDeliveryId: number): Promise<SsgIssueLogEntity[]> {
    return this.ssgIssueLogRepository.find({
      where: { orderDeliveryId, supersededAt: IsNull() },
      order: { id: 'DESC' },
    });
  }

  /**
   * 미확정 SSG INSERT 의 durable 후보를 판정한다 (EP-P30 §5-3-1, §6-B-2). **순수 함수**다:
   * DB 쓰기 0회, 메모리 entity 미변경. PIN 복원은 `applyConfirmedCandidate` 소관이고,
   * 관측 기록은 독립 observer(`SsgPinObservationSweepService`) 소관이다 — 판정 자체는 아무것도 쓰지 않는다.
   *
   * ```
   * !hasAnyAttempt                       → NOT_ATTEMPTED   (SSG 호출 0회)
   * hasAnyAttempt && 활성후보 0        → UNKNOWN         (tombstone 만 존재 — 재개 판단은 P1)
   * 그 외                              → 후보별 판정 → 집계
   * ```
   */
  async classifyDeferredSsgIssue(orderDeliveryId: number): Promise<SsgDeferredClassification> {
    const allRows = await this.ssgIssueLogRepository.find({
      where: { orderDeliveryId },
      order: { id: 'DESC' },
    });
    const active = allRows.filter((candidate) => candidate.supersededAt === null);

    if (allRows.length === 0) {
      const [archiveHit] = await this.ssgIssueLogRepository.query(
        `SELECT 1 AS hit FROM ssg_issue_log_ops_archive WHERE order_delivery_id = ? LIMIT 1`,
        [orderDeliveryId],
      );
      if (archiveHit) {
        return {
          resolution: SsgPinResolution.UNKNOWN,
          hasAnyAttempt: true,
          activeCandidateCount: 0,
          verdicts: [],
        };
      }
      return {
        resolution: SsgPinResolution.NOT_ATTEMPTED,
        hasAnyAttempt: false,
        activeCandidateCount: 0,
        verdicts: [],
      };
    }
    if (active.length === 0) {
      // 시도 이력은 있고 활성 후보만 없다 — 미시도가 아니므로 ordinal=1 재발급으로 가면 안 된다.
      return {
        resolution: SsgPinResolution.UNKNOWN,
        hasAnyAttempt: true,
        activeCandidateCount: 0,
        verdicts: [],
      };
    }

    const { resolution, confirmedCandidate, verdicts } = await this.withSsgMutex(() =>
      this.resolveSsgPinCandidates(active),
    );
    return { resolution, confirmedCandidate, hasAnyAttempt: true, activeCandidateCount: active.length, verdicts };
  }

  /**
   * Resolves the durable candidates for a deferred SSG INSERT. A confirmed
   * candidate is restored onto the delivery so the caller can send it without
   * another INSERT.
   */
  async resolveDeferredSsgIssue(orderDelivery: OrderDeliveryEntity): Promise<SsgPinResolution> {
    const { resolution, confirmedCandidate } = await this.classifyDeferredSsgIssue(orderDelivery.id);
    if (resolution === SsgPinResolution.CONFIRMED && confirmedCandidate) {
      await this.applyConfirmedCandidate(orderDelivery, confirmedCandidate);
    }
    return resolution;
  }

  /**
   * 신규 INSERT 게이트 (§6-B-3). 판정값만으로 진행하는 분기를 전부 이 뒤로 보낸다.
   *
   * 차수는 **호출자가 명시**한다. `external_issue_count` 로 추론하면 안 된다 — 재발급 권한은
   * 소비 **전**(count=1)에 검사하므로 count 추론은 재발급을 ordinal=1 로 오판하고,
   * 그러면 1차만 열은 단계(P1)에서 2차 INSERT 가 그대로 통과한다.
   *
   * 게이트는 배포 capability 와 실행 증거를 **둘 다** 요구한다(`canExecuteOrdinal`). 재발급 증거
   * 수집 경로는 P3 소관이므로, 지금은 `ORDINAL_2_REISSUE` 상수를 뒤집어도 재발급이 열리지 않는다.
   */
  private async resolveInsertGate(
    authority: PinIssueCommandAuthority | undefined,
    ordinal: SsgIssueOrdinal,
    evidence?: SsgOrdinal2Evidence,
  ): Promise<{ capability: SsgAutoResolveCapability; ordinal: SsgIssueOrdinal; allowed: boolean; missing: string[] }> {
    const command = authority
      ? await this.pinIssueCommandRepository.findOne({ where: { id: authority.commandId } })
      : null;
    const capability = this.autoResolveConfig.capabilityFor(command);
    const { allowed, missing } = canExecuteOrdinal(capability, ordinal, evidence);
    return { capability, ordinal, allowed, missing };
  }

  /**
   * PIN 발급 결과를 order_delivery 에 즉시 durable 반영한다.
   *
   * ★ issue() 의 **모든 성공 반환 경로**가 이걸 타야 한다 (리뷰 CRITICAL).
   *
   * 종전에는 메인 경로(협력사 발급 완료 지점)에서만 호출했고, 조기 return 하는 경로들은
   * barCode 를 **메모리에만** 채운 뒤 caller 의 `save(orderDelivery)` 가 영속시켜 줬다.
   * D3-60(clobber) 대응으로 그 save 들을 targeted update 로 바꾸면서 PIN 컬럼이 대상에서
   * 빠졌고, 그 결과 조기 return 경로에서 `bar_code` 가 **NULL 로 남는** 결함이 생겼다.
   *
   * 그 결말:
   *  - 고객은 바코드를 받았는데(이미지·문자에 담겨 나감) 우리 DB 엔 없다 → CS 조회 불가
   *  - 재발송 시 `!barCode` 판정 → **새 PIN 재발급·재과금** (고객이 가진 것과 불일치)
   *  - cancelOrder/execDiscard 의 `if (barCode && partnerCompany)` 가드가 falsy →
   *    **협력사 취소를 건너뛴 채 환불만 집행** → 협력사엔 살아있는 핀 + 환불 완료 = 자금 손실
   *
   * ★ REQUIRES_NEW 인 이유 (리뷰 CRITICAL) — issue() 의 트랜잭션과 **운명을 분리**해야 한다.
   *
   *   협력사 발급(HTTP)은 롤백 대상이 아니다. 그런데 REQUIRED 로 두면 issue() 가 이후 어디서든
   *   throw 할 때 이 update 가 **함께 롤백**되어, "협력사엔 발급·과금된 핀 + 우리 DB 는 NULL" 이
   *   된다. 그 상태의 결말이 위에 적은 3가지다(특히 cancel 이 협력사 취소를 건너뛴 채 환불 집행).
   *
   *   종전(save 시절)에는 caller 의 save(orderDelivery) 가 issue() **밖**에서 실행돼 롤백돼도
   *   메모리의 barCode 를 다시 써 줬다. targeted update 로 바꾸면서 그 안전망이 사라졌으므로,
   *   여기서 명시적으로 트랜잭션을 분리해 복원한다.
   *
   *   같은 이유로 SsgInsertStateService 의 markAttempted/markConfirmed 도 REQUIRES_NEW 다
   *   ("호출자 트랜잭션이 롤백돼도 state 는 함께 commit 된다").
   *
   * ⚠️ self-deadlock 검토 (과거 재발행 비관락이 markConfirmed(REQUIRES_NEW) 와 얼어붙은 전례):
   *   REQUIRES_NEW 는 **별도 커넥션·별도 트랜잭션**이므로, 호출자가 이 order_delivery 행에
   *   X-lock 을 쥔 채 issue() 를 호출하면 여기서 영원히 블록된다(lock wait timeout).
   *   issue() 호출자 5곳을 전수 확인했다:
   *     - delivery.batch(발송배치/oneSend) : 트랜잭션 없음
   *     - customer.service(재발행)          : execHistory 는 @Transactional 아님
   *     - external_api(phaseB)              : "Phase B: 쿠폰 발행 + 발송 (트랜잭션 없음)" 명시
   *     - order_receive(x2)                 : sendToMMS 만 @Transactional 인데, 그 안에서
   *       order_delivery 는 **락 없는 SELECT** 만 하고(claim 은 별도 REQUIRES_NEW 에서 CAS),
   *       쓰기는 issue() **뒤**에 온다 → X-lock 미보유.
   *   결정적 근거: markConfirmed(REQUIRES_NEW)가 이미 같은 경로에서 order_delivery 를
   *   UPDATE 하고 있고 운영에서 정상 동작한다. 같은 구조다.
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  async persistIssuedPin(orderDelivery: OrderDeliveryEntity): Promise<void> {
    await this.orderDeliveryRepository.update(
      { id: orderDelivery.id },
      {
        barCode: orderDelivery.barCode,
        personalCode: orderDelivery.personalCode,
        couponNum: orderDelivery.couponNum,
        ssgTransactionId: orderDelivery.ssgTransactionId,
        expireAt: orderDelivery.expireAt,
        encourageAt: orderDelivery.encourageAt,
        ...(orderDelivery.ssgEventId != null ? { ssgEventId: orderDelivery.ssgEventId } : {}),
      },
    );

    // ── P1 정산 원장 (B14 §4 P1 — 발행분 ISSUANCE) ──────────────────────────
    // 이미 REQUIRES_NEW 안이므로 same-tx(§6.5). 멱등키 ISS:{orderDeliveryId} 로 중복 0.
    await this.recordIssuanceSettlement(orderDelivery);
  }

  @Transactional({ propagation: Propagation.REQUIRED })
  async issue(
    orderDelivery: OrderDeliveryEntity,
    ssgEvent: SsgEventEntity | null,
    resendDeductionId?: string,
    ssgIssueAuthority?: PinIssueCommandAuthority,
    issueOrdinal?: number | null,
  ): Promise<PartnerIssueResult> {
    if (ssgIssueAuthority && (issueOrdinal == null || ![1, 2].includes(issueOrdinal))) {
      throw new InternalServerErrorException(
        `SSG INSERT ordinal is required when authority is present. commandId=${ssgIssueAuthority.commandId}, ordinal=${issueOrdinal}`,
      );
    }
    const type = orderDelivery.orderProductMapping!.product.partnerCompany!.type;
    // issue 결과(배치 재발송 선차감 정합). 기본=재사용(false)·현재 귀속 행사. SSG 신규 INSERT 시 갱신.
    const result: PartnerIssueResult = { ssgNewIssue: false, ssgEventId: orderDelivery.ssgEventId ?? null };
    // ── PIN_INVENTORY 재고형 쿠폰 전용 분기 (rev5 §7.2) ──
    // 외부 dedup/transactionId/history/barCode 로직 전에 전용 allocation service를 호출하고 반환한다.
    // barCode 가짜 값, 외부 협력사 API, 취소/상태조회, pin_issue_dedup, 외부 이력을 사용하지 않는다.
    if (type === IPartnerCompanyType.PIN_INVENTORY) {
      return {
        ssgNewIssue: false,
        ssgEventId: null,
        inventoryPinItemId: undefined, // allocation은 batch/delivery 레벨에서 처리
      };
    }

    // deliveryTarget 복호화
    const decryptedDeliveryTarget =
      this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget) ?? orderDelivery.deliveryTarget;

    let context = '';
    let isSuccess = true;
    if (!orderDelivery.transactionId) {
      throw new Error('transaction id not exist');
    }

    // PIN 발급 중복 방지: 같은 transactionId로 동시에 issue()가 두 번 호출되는 것을 차단
    // (배치 vs 수동 동시 호출 등). 모든 협력사가 동일 로직으로 관리된다.
    //
    // CULTURELAND의 0099 복구 프로토콜도 dedup과 호환된다:
    // 1차 실패(0099 throw) → @Transactional 롤백 → dedup row 자동 삭제
    // 2차 재시도(동일 trId) → INSERT 정상 → 협력사가 기존 PIN 반환(0000) → 성공
    //
    // conflict 발생 시 즉시 throw하지 않고, 먼저 끝난 트랜잭션의 bar_code를 읽어와
    // 그대로 이어받는다(인라인 recovery). InnoDB row lock 특성상 B가 ER_DUP_ENTRY를 보는 시점에는
    // A가 이미 commit 완료 상태이므로 A의 bar_code는 반드시 존재함이 보장된다.
    if (type) {
      try {
        await this.pinIssueDedupRepository.insert({
          transactionId: orderDelivery.transactionId,
          orderDeliveryId: orderDelivery.id,
          partnerType: type,
          recoveredFrom: 'FRESH_ISSUE',
          issuedAt: new Date(),
        });
      } catch (e) {
        if (e instanceof QueryFailedError && (e as QueryFailedError & { code?: string }).code === 'ER_DUP_ENTRY') {
          // ER_DUP_ENTRY = 이 호출이 외부 INSERT 를 수행하지 않은 dedup loser 로 확정(전달 ssgEvent=선차감 C 미사용).
          // 어떤 추가 DB 조회(아래 dedup/fresh 조회)보다 먼저 REUSED 를 durable 기록 → 조회 중 크래시해도
          // sweep 이 승자가 만든 CONFIRMED 를 loser 신규발급으로 오판하지 않고 선차감을 REVERSED 한다.
          await this.markReissuePendingReusedIfBatch(resendDeductionId);
          const existing = await this.pinIssueDedupRepository.findOne({
            where: { transactionId: orderDelivery.transactionId },
          });

          if (existing?.barCode) {
            // 상대 트랜잭션이 이미 성공 완료한 상태 → 그 bar_code를 그대로 이어받고 협력사 호출 생략.
            // issue() 내부 save(Fix #3) 덕분에 DB의 order_delivery row에도 PIN 관련 필드가 반영되어 있으므로
            // 메모리상 entity에 fresh DB 값을 모두 복원해 caller가 일관된 상태로 진행하도록 한다.
            // (이전에는 barCode만 복원해서 SSG의 personalCode/ssgTransactionId/expireAt이 누락되는 버그가 있었음)
            this.logger.warn(
              `[PIN_DEDUP] 중복 감지 - 기존 발급 이어받음. transactionId: ${orderDelivery.transactionId}, orderDeliveryId: ${orderDelivery.id}, type: ${type}, barCode: ${existing.barCode}`,
            );
            const fresh = await this.orderDeliveryRepository.findOne({
              where: { id: orderDelivery.id },
            });
            if (fresh?.barCode) {
              orderDelivery.barCode = fresh.barCode;
              orderDelivery.personalCode = fresh.personalCode;
              orderDelivery.couponNum = fresh.couponNum;
              orderDelivery.ssgTransactionId = fresh.ssgTransactionId;
              orderDelivery.expireAt = fresh.expireAt;
              orderDelivery.encourageAt = fresh.encourageAt;
              // MEDIUM: 행사 귀속(ssgEventId)도 함께 복원 — 누락 시 이후 stale save 가 잘못된 행사로 덮어쓴다.
              orderDelivery.ssgEventId = fresh.ssgEventId;
              result.ssgEventId = fresh.ssgEventId ?? null;
              await this.pinIssueDedupRepository.update(
                { transactionId: orderDelivery.transactionId },
                { recoveredFrom: 'DEDUP' },
              );
              return result;
            } else if (type === IPartnerCompanyType.SSG) {
              // dedup 이 가리키는 '정확한' barCode 의 ssg_issue_log row 에서 전체 payload(행사귀속 포함)를 복원한다.
              // (barCode 만 복원하면 personalCode/ssgTransactionId/유효기간/ssgEventId 누락. 최신 로그 auto-select 는
              //  다른 시도의 PIN 을 잘못 복원할 수 있어 정확 매칭으로 한정.)
              const exact = await this.ssgIssueLogRepository.findOne({
                where: { orderDeliveryId: orderDelivery.id, barCode: existing.barCode },
                order: { id: 'DESC' },
              });
              if (exact) {
                orderDelivery.barCode = exact.barCode;
                orderDelivery.personalCode = exact.personalCode;
                orderDelivery.couponNum = exact.couponNum;
                orderDelivery.ssgTransactionId = exact.ssgTransactionId;
                orderDelivery.expireAt = exact.expireAt;
                orderDelivery.encourageAt = exact.encourageAt;
                if (exact.ssgEventId != null) {
                  orderDelivery.ssgEventId = exact.ssgEventId;
                }
                result.ssgEventId = orderDelivery.ssgEventId ?? null;
                await this.pinIssueDedupRepository.update(
                  { transactionId: orderDelivery.transactionId },
                  { recoveredFrom: 'DEDUP' },
                );
                // ssg_issue_log 에서 메모리로만 복원한 PIN — DB order_delivery 는 아직 NULL 이다
                // (이 분기 진입 조건 자체가 fresh?.barCode 부재). 반드시 durable 반영한다.
                await this.persistIssuedPin(orderDelivery);
                return result;
              }
              // 정확 매칭 없음: barCode-only 성공 반환은 메타데이터 누락 + cust_info 우회라 위험.
              // dedup row 를 복구표시하지 않고 아래 ConflictException 으로 fail-safe(재시도). 동시 tx 의
              // order_delivery save 가 전파되면 다음 시도에서 fresh?.barCode 경로가 정상 복구한다.
              this.logger.warn(
                `[PIN_DEDUP] SSG dedup exact 매칭 없음 - fail-safe(ConflictException, 재시도 시 fresh 경로 복구). orderDeliveryId=${orderDelivery.id}, barCode=${existing.barCode}`,
              );
            } else {
              // 비-SSG 최후 폴백 (ssg_issue_log 진실원천 없음)
              orderDelivery.barCode = existing.barCode;
              await this.pinIssueDedupRepository.update(
                { transactionId: orderDelivery.transactionId },
                { recoveredFrom: 'DEDUP' },
              );
              // 메모리로만 복원한 PIN — DB order_delivery 는 아직 NULL 이다. 반드시 durable 반영.
              await this.persistIssuedPin(orderDelivery);
              return result;
            }
          }

          // 이론상 도달 불가 경로(conflict 시점에는 상대가 성공 커밋되어 bar_code가 있어야 함).
          // 안전 가드로 ConflictException 유지 — 운영 중 발생하면 로그로 조사 가능.
          this.logger.error(
            `[PIN_DEDUP] 중복 감지되었으나 기존 bar_code 복구 실패 - transactionId: ${orderDelivery.transactionId}, orderDeliveryId: ${orderDelivery.id}, type: ${type}`,
          );
          throw new ConflictException(
            `이미 동일 거래번호로 PIN 발급 요청이 진행 중입니다. (transactionId: ${orderDelivery.transactionId})`,
          );
        }
        throw e;
      }
    }

    try {
      if (!type || orderDelivery.orderProductMapping.product.type === 'SELF') {
        // 자체 상품 — 협력사 호출 없이 우리가 바코드를 만든다. 그래도 **DB 에 반드시 남겨야** 한다.
        // 이 바코드는 곧 쿠폰 이미지에 찍혀 고객에게 나간다. DB 에 없으면 CS 조회도, 재발송 시
        // 동일 핀 재사용도 불가능하다(!barCode → 다른 바코드 재생성 → 고객이 받은 것과 불일치).
        orderDelivery.barCode = orderBarcodeGenerate();
        await this.persistIssuedPin(orderDelivery);
        return result;
      }

      // 1.1.1 갤럭시아 쿠폰 발급
      // 표준연동발행규격서 v.1.6.8_갤럭시아머니트리.pdf
      if (type === 'GALAXIA') {
        // 이미 발급된 쿠폰이 있으면 중복 호출 방지
        if (orderDelivery.barCode && orderDelivery.couponNum) {
          this.logger.warn(
            `[GALAXIA] 이미 발급된 쿠폰 존재 - barCode: ${orderDelivery.barCode}, couponNum: ${orderDelivery.couponNum}, 발급 skip`,
          );
          return result;
        }

        const giftKind = orderDelivery.orderProductMapping.product.name.includes('(백화점)') ? 'dept' : 'cpn';
        // 개인정보 보호: 백화점(dept)만 실제 전화번호 전달, 그 외는 더미 번호 사용
        const phoneNumberForGalaxia = giftKind === 'dept' ? decryptedDeliveryTarget : '01000000000';
        const galaxiaOut = await this.galaxia.issue({
          transactionId: orderDelivery.transactionId,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
          fromPhoneNumber: phoneNumberForGalaxia,
          giftKind,
          // 백화점(dept) 상품권의 경우 액면가 필수
          faceValue: giftKind === 'dept' ? String(orderDelivery.orderProductMapping.product.price) : undefined,
          // cpn의 경우 duration(유효일수, raw) 전달. 우선순위: OPM galaxiaDuration ?? Product galaxiaDuration ?? Product expireDay ?? 0.
          // galaxiaDuration 미구현 단계의 임시방편: 상품 유효기간(expireDay)만 설정해도 발행 유효기간이 반영된다.
          // 여기엔 validityStartsNextDay 보정을 적용하지 않는다 — 보정은 ePOPKON 내부 expireAt 날짜 계산(addDays) 전용이고,
          // Galaxia는 raw 유효일수를 받아 자체적으로 만료일을 산출한다. 0은 Galaxia 측 최대 유효기간으로 발행된다.
          duration:
            giftKind === 'cpn'
              ? (orderDelivery.orderProductMapping.galaxiaDuration ??
                orderDelivery.orderProductMapping.product.galaxiaDuration ??
                orderDelivery.orderProductMapping.product.expireDay ??
                0)
              : undefined,
        });
        context = JSON.stringify(galaxiaOut);

        // 409 복구 응답의 경우 barcode가 비어있을 수 있음 - couponNum(trId)은 저장
        orderDelivery.couponNum = galaxiaOut.transactionId;
        if (galaxiaOut.giftCertificate.barcode) {
          orderDelivery.barCode = galaxiaOut.giftCertificate.barcode;
        } else {
          // barcode 없이 couponNum만 복구된 경우 (409 중복 복구)
          this.logger.warn(
            `[GALAXIA] 중복 복구: barcode 없음, couponNum(trId): ${galaxiaOut.transactionId}. ` +
              `transactionId: ${orderDelivery.transactionId}`,
          );
        }
      }

      // 1.1.2 GSMBIZ 쿠폰 발급
      // GSM쿠폰_전문사양서_고객사_표준V3.4_20200529.pdf
      if (type === 'GS_M_BIZ') {
        const gsMBizOut = await this.gsmbiz.issue({
          transactionId: orderDelivery.transactionId,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
        });
        context = JSON.stringify(gsMBizOut);
        orderDelivery.barCode = gsMBizOut.couponInfo.barCode;
      }

      // 1.1.3 Giftiel 쿠폰 발급
      // giftiel(기프티엘)_공통_판매사_연동가이드_v2.1.0.0_20210409.pdf
      if (type === 'GIFTIEL') {
        const giftielOut = await this.giftiel.issue({
          transactionId: orderDelivery.transactionId,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
        });

        context = JSON.stringify(giftielOut);

        // GIFTIEL 응답 가드: 실패 응답(예: 0227 중복)일 때 CouponList가 비어있어
        // 기존 코드(CouponList[0].CouponNum)가 TypeError를 내면서 실제 원인이 묻혔다.
        // 협력사 응답 코드/메시지가 history에 그대로 남도록 명시적으로 throw한다.
        if (giftielOut.ResultCode !== '0000' || !giftielOut.CouponList?.length) {
          throw new Error(`GIFTIEL 발급 실패: ${giftielOut.ResultCode} - ${giftielOut.ResultMsg}`);
        }
        orderDelivery.barCode = giftielOut.CouponList[0].CouponNum;
      }

      // 1.1.4 giftshow 쿠폰 발급
      // 기프티쇼_매체_연동규격서_v1.9.1.2.pdf
      if (type === 'GIFT_SHOW') {
        const giftShowOut = await this.giftiShow.issue({
          transactionId: orderDelivery.transactionId,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
        });
        context = JSON.stringify(giftShowOut);

        const responseCode = giftShowOut.response.result[0].code[0];
        const responseReason = giftShowOut.response.result[0].reason[0];

        if (responseCode === '1000') {
          // 성공
          const pinNo = giftShowOut.response.value[0].pin_no[0];
          if (!pinNo || pinNo === 'null') {
            throw new Error('GIFT_SHOW 발급 성공이나 pin_no가 유효하지 않습니다');
          }
          orderDelivery.barCode = pinNo;
        } else if (responseCode === '3001') {
          // 중복 요청 - 기존 발급된 PIN 조회
          this.logger.warn(
            `GIFT_SHOW 중복 요청 감지 - transactionId: ${orderDelivery.transactionId}, 기존 PIN 조회 시도`,
          );
          const checkResult = await this.giftiShow.check({
            transactionId: orderDelivery.transactionId,
          });

          if (checkResult.resCode === '0000' && checkResult.couponInfo?.pinNo) {
            // 기존 PIN 조회 성공 - 같은 transactionId로 발급된 PIN이므로 동일 주문
            this.logger.log(`GIFT_SHOW 기존 PIN 조회 성공 - pinNo: ${checkResult.couponInfo.pinNo}`);
            orderDelivery.barCode = checkResult.couponInfo.pinNo;
          } else {
            // 기존 PIN 조회 실패 - 이상한 상황
            throw new Error(
              `GIFT_SHOW 중복 요청이나 기존 PIN 조회 실패: ${checkResult.resCode} - ${checkResult.resMsg}`,
            );
          }
        } else {
          // 기타 에러
          throw new Error(`GIFT_SHOW 발급 실패: ${responseCode} - ${responseReason}`);
        }
      }

      // 1.1.5 컬쳐랜드 쿠폰 발급
      // 컬쳐랜드상품권(모바일문화상품권)_구매_연동가이드_V3.0.pdf
      if (type === 'CULTURELAND') {
        const cultureLandOut = await this.culture.issue({
          transactionId: orderDelivery.transactionId,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
          expireDay: orderDelivery.orderProductMapping.product.expireDay,
          price: orderDelivery.orderProductMapping.product.price,
        });
        context = JSON.stringify(cultureLandOut);

        // 성공 응답인 경우에만 barCode 설정
        if (cultureLandOut.ResultCode === '0000') {
          orderDelivery.barCode = cultureLandOut.ScrachNo;
          orderDelivery.couponNum = cultureLandOut.CertNo;
        } else {
          throw new Error(`컬쳐랜드 PIN 발급 실패: ${cultureLandOut.ResultCode}`);
        }
      }

      // 1.1.6 신세계 상품권 발행
      // PIN 생성~중복확인~INSERT 전체를 Mutex로 직렬화하여 동시 요청 간 PIN 충돌 방지
      // (PM2 단일 인스턴스 전제)
      if (type === 'SSG') {
        if (!ssgEvent) {
          throw new InternalServerErrorException('ssg event 가 존재하지 않습니다.');
        }

        // 1) 기존 PIN이 있으면 SSG 상태 판정 (mutex 불필요: 새 PIN 생성과 경쟁하지 않음)
        //    GetSsgTry(cust_info 제출여부) + GetSsgStatus(cust_info_result 결과/유효성) 조합.
        //    네트워크/파싱 오류는 classifySsgPin 이 throw → 등록 여부 불명이므로 안전을 위해 중단.
        let needsInsert = true;
        if (orderDelivery.barCode && orderDelivery.personalCode) {
          const verdict = await this.classifySsgPin({
            eventNo: ssgEvent.no,
            eventSeq: ssgEvent.order,
            personalCode: orderDelivery.personalCode,
          });

          if (verdict === SsgPinResolution.CONFIRMED) {
            // result 유효 → INSERT는 됐고 발송만 실패 → 기존 PIN 재사용
            needsInsert = false;
            // 재사용 확정 — 배치 선차감(C) 을 sweep 이 state 무관하게 REVERSED 하도록 durable 마킹(markConfirmed 전).
            await this.markReissuePendingReusedIfBatch(resendDeductionId);
            this.logger.log(`[SSG] 기존 PIN이 SSG DB에 등록(유효) - barCode: ${orderDelivery.barCode}, INSERT 건너뜀`);
            // state ATTEMPTED → CONFIRMED 동기화 (markConfirmed 는 WHERE state=ATTEMPTED 가드라 그 외엔 silent skip).
            // ssgTransactionId 가 NULL 인 legacy row 는 markConfirmed 호출 자체를 skip (NOT NULL 타입 보호).
            if (orderDelivery.ssgTransactionId) {
              await this.ssgInsertStateService.markConfirmed(orderDelivery.id, {
                barCode: orderDelivery.barCode,
                personalCode: orderDelivery.personalCode,
                ssgTransactionId: orderDelivery.ssgTransactionId,
                couponNum: orderDelivery.couponNum ?? null,
                expireAt: orderDelivery.expireAt ?? null,
                encourageAt: orderDelivery.encourageAt ?? null,
              });
            }
          } else {
            // A non-confirmed result is never sufficient to discard and re-issue a PIN.
            throw new SsgIssueUnknownError(`SSG 기존 PIN 판정 미확정(${verdict}). orderDeliveryId=${orderDelivery.id}`);
          }
        }

        // 1b) barCode 없음 → ssg_issue_log 후보(직전 시도 PIN)를 cust_info 진실원천으로 후보별 분류해
        //     재사용/보류/새발급을 결정한다. 1차 발송 실패가 tx 롤백으로 barCode 를 남기지 못한 고아 PIN 을
        //     모든 issue() 진입점(배치/CS reSend/재발송)에서 균일 처리(결정점 단일화).
        //     state 가 아니라 '후보 존재 여부'로 판단한다(Lazy state 도입 전 legacy ssg_issue_log 도 커버).
        //     resolveSsgOrphan 은 등록실패(resultCd 0103 등)도 CONFIRMED 로 보는 '환불용' 판정이라 재사용엔 쓰지 않고,
        //     등록실패를 NOT 재사용으로 구분하는 classifySsgPin 으로 후보를 분류한다.
        //     eventSeq 없는 legacy 후보는 check 파라미터가 부족하므로 getTry(제출여부)만으로 보류 판단한다.
        if (!orderDelivery.barCode) {
          const allCandidates = await this.findActiveSsgCandidates(orderDelivery.id);
          const candidates = allCandidates.filter((c) => !!c.personalCode);

          if (candidates.length > 0) {
            const { resolution, confirmedCandidate } = await this.resolveSsgPinCandidates(candidates);

            if (resolution === SsgPinResolution.CONFIRMED && confirmedCandidate) {
              await this.markReissuePendingReusedIfBatch(resendDeductionId);
              await this.applyConfirmedCandidate(orderDelivery, confirmedCandidate);
              needsInsert = false;
              result.ssgEventId = orderDelivery.ssgEventId ?? null;
              this.logger.log(
                `[SSG] 단일 등록 확정 후보 재사용(barCode=${confirmedCandidate.barCode}). orderDeliveryId=${orderDelivery.id}`,
              );
            } else if (resolution === SsgPinResolution.NOT_ISSUED) {
              // EP-P30 §6-B-3-1 — 게이트 미통과를 needsInsert=false 로 표현하면 그건 "재사용 확정" 신호라
              // PIN payload 가 빈 채 정상 반환된다(무발급 성공·null PIN 발송·command 오종결).
              // 반드시 정상 반환 전에 중단한다.
              // 기존 후보가 있는데 NOT_ISSUED 로 판정된 건은 정의상 재발급(2차)이다.
              const gate = await this.resolveInsertGate(ssgIssueAuthority, 2);
              if (!gate.allowed) {
                throw new SsgAutoResolveBlockedError(orderDelivery.id, resolution, gate.ordinal);
              }
            } else {
              // UNKNOWN, LOOKUP_FAILED, REGISTERED_UNSENDABLE, MULTIPLE_CONFIRMED must not issue or select a PIN.
              throw new SsgIssueUnknownError(
                `SSG 후보 판정 미확정(${resolution}). orderDeliveryId=${orderDelivery.id}`,
              );
            }
          } else {
            const [archiveHit] = await this.ssgIssueLogRepository.query(
              `SELECT 1 AS hit FROM ssg_issue_log_ops_archive WHERE order_delivery_id = ? LIMIT 1`,
              [orderDelivery.id],
            );
            if (archiveHit) {
              throw new SsgIssueUnknownError(
                `SSG archive 이력 존재 — clean 발급 차단. orderDeliveryId=${orderDelivery.id}`,
              );
            }
          }
          // 후보 0건 + archive 0건(최초 clean 발송) → 새 PIN. 외부 SSG API 추가호출 없음(hot-path 보존).
        }

        // 2~4단계를 Mutex로 직렬화: PIN 생성~중복확인~INSERT 간 경쟁 조건 방지.
        // (Mutex 는 프로세스 로컬이라 다중 노드 안전 권위가 아니다. 후보 PIN 유일성의 권위는
        //  ssg_issue_log 의 uq_ssg_issue_log_bar_code / _personal_code UNIQUE 제약이다.
        //  docs/plans/2026-08-04-ssg-issue-log-unique-typed-collision.md)
        context = await this.withSsgMutex(async () => {
          // 기존 PIN 재사용 확정(needsInsert=false) → 새 PIN 생성도 markAttempted 도 하지 않는다.
          // 유효기간은 SSG DB 실제 값과 어긋나지 않도록 그대로 보존한다.
          if (!needsInsert) {
            return '';
          }

          // 후보 루프. 후보 1회 = 생성 → 로컬 조회 → getTry → trId/유효기간 → 본문 → markAttempted.
          // ssg_issue_log 유일성 충돌만 다음 후보로 넘어가고, 그 외 오류는 즉시 전파한다.
          // maxRetries 는 전체 후보 수 상한이다. 생성 루프와 충돌 재시도를 중첩하면
          // 충돌마다 생성이 다시 5회 돌아 최대 25 후보가 만들어지므로 단일 루프로 유지한다.
          const maxRetries = 5;
          for (let attempt = 0; attempt < maxRetries; attempt++) {
            // 2) 새 PIN 생성 + 2중 중복 확인
            const { barCode, personalCode } = this.ssgIssue.generateSsgIssue();

            // 1차 중복 확인: 로컬 ssg_issue_log + ops_archive UNION (빠름).
            // SELECT 이므로 비원자적 — 최종 판정은 UNIQUE 제약.
            // ops_archive 는 수동 복구 시 DELETE된 PIN 4행 보존. tombstone 전환 후 신규 유입 없음.
            const [localDuplicate] = await this.ssgIssueLogRepository.query(
              `SELECT 1 AS hit FROM ssg_issue_log WHERE bar_code = ? OR personal_code = ?
               UNION ALL
               SELECT 1 FROM ssg_issue_log_ops_archive WHERE bar_code = ? OR personal_code = ?
               LIMIT 1`,
              [barCode, personalCode, barCode, personalCode],
            );
            if (localDuplicate) {
              this.logger.warn(
                `[SSG] 로컬 블랙리스트 중복 감지 - barCode: ${barCode}, personalCode: ${personalCode}, 재생성 시도 (${attempt + 1}/${maxRetries})`,
              );
              continue;
            }

            // 2차 중복 확인: SSG cust_info (GetSsgTry). 제출 이력 = 중복.
            // personalCode 단독(전 행사 합산) 조회라 cust_info_result(GetSsgStatus)보다 중복번호 검출이 정확.
            try {
              const tryOut = await this.ssgIssue.getTry({ vno: personalCode });
              const tryYn = tryOut?.response?.value?.[0]?.tryYn?.[0];
              if (tryYn === 'Y') {
                // 제출 이력 존재 = 중복
                this.logger.warn(
                  `[SSG] cust_info 중복 감지 - personalCode: ${personalCode}, 재생성 시도 (${attempt + 1}/${maxRetries})`,
                );
                continue;
              }
              // tryYn === 'N' = 미사용 → 사용 가능
            } catch (e) {
              // getTry 실패(검증 거절/네트워크/파싱) → 중복 여부 불명 → 안전을 위해 중단
              this.logger.error(
                `[SSG] PIN 중복 확인(GetSsgTry) 오류 - personalCode: ${personalCode}, 안전을 위해 중단: ${e instanceof Error ? e.message : e}`,
              );
              throw e;
            }

            orderDelivery.barCode = barCode;
            orderDelivery.personalCode = personalCode;
            this.logger.log(`[SSG] PIN 생성 완료 - barCode: ${barCode}, personalCode: ${personalCode}`);

            // 3) 유효기간 및 트랜잭션 ID 설정 — 후보마다 새로 산출한다.
            orderDelivery.ssgTransactionId = SsgTransactionId.makeSsgTrade();
            orderDelivery.expireAt = addDays(new Date(), orderDelivery.orderProductMapping.product.expireDay - 1);
            const encourageDay = orderDelivery.orderProductMapping.encourageDay;
            // encourageDay 가 없으면 명시적으로 null 이다. expireAt 은 무조건 재산출되므로,
            // 이전 시도(실패/고아/충돌 후보)가 남긴 encourageAt 을 그대로 두면 옛 expireAt 기준
            // 알림일이 새 후보에 붙는다.
            orderDelivery.encourageAt = encourageDay ? subDays(orderDelivery.expireAt, encourageDay) : null;

            // 4) SSG DB INSERT
            // 본문(smsSsgTemplate)은 personalCode/barCode/expireAt 을 직접 담으므로 후보마다 재산출해야 한다.
            // 재사용하면 옛 후보의 PIN 이 적힌 본문을 SSG 로 보내게 된다.
            let text = orderDelivery.orderProductMapping.sendContent ?? '';

            if (orderDelivery.orderProductMapping.sendTailText) {
              text += orderDelivery.orderProductMapping.sendTailText;
            }
            text = applyReplaceCharacters(text, orderDelivery);

            const textForSsg = text + smsSsgTemplate(orderDelivery);

            const callBackNumber = orderDelivery.orderProductMapping.fromPhoneNumber || systemFromPhoneNumber;

            // SSG INSERT 직전: durable state ATTEMPTED + ssg_issue_log payload 기록 (REQUIRES_NEW).
            // plans/ssg-balance-refactor.md PR2.
            // markAttempted 결과가 TRANSITIONED 가 아니면 외부 INSERT 호출 금지 (state/log 없는 INSERT 위험).
            const attemptPayload: SsgAttemptPayload = {
              barCode: orderDelivery.barCode,
              personalCode: orderDelivery.personalCode,
              ssgTransactionId: orderDelivery.ssgTransactionId,
              eventNo: ssgEvent.no,
              eventSeq: ssgEvent.order,
              ssgEventId: ssgEvent.id,
              expireAt: orderDelivery.expireAt ?? null,
              encourageAt: orderDelivery.encourageAt ?? null,
              couponNum: orderDelivery.couponNum ?? null,
              pinIssueCommandId: ssgIssueAuthority?.commandId ?? null,
              issueOrdinal: issueOrdinal ?? null,
            };
            let markResult: MarkAttemptedResult;
            try {
              markResult = await this.ssgInsertStateService.markAttempted(
                orderDelivery.id,
                attemptPayload,
                ssgIssueAuthority,
              );
            } catch (e) {
              if (e instanceof SsgIssueLogKeyCollisionError) {
                // 다른 발송 건이 이 후보를 선점했다. markAttempted 의 REQUIRES_NEW 가 통째로 롤백되어
                // state 도 충돌 이전 값이므로, 후보만 폐기하고 다음 후보로 진행한다.
                // 충돌은 ssgIssue.issue() 이전에 발생하므로 벤더 호출은 0 이다.
                this.logger.warn(
                  `[SSG] 후보 PIN 선점됨(${e.collidedKey}) - barCode: ${barCode}, personalCode: ${personalCode}, 재생성 시도 (${attempt + 1}/${maxRetries})`,
                );
                orderDelivery.barCode = null;
                orderDelivery.personalCode = null;
                orderDelivery.ssgTransactionId = null;
                continue;
              }
              throw e;
            }
            if (markResult === MarkAttemptedResult.SKIPPED_ACTIVE) {
              // state=ATTEMPTED (이전 INSERT 9999 등). Mutex 내부라 동시 흐름 직렬화됨.
              // classifySsgPin 결과는 mutex 밖(stale 가능) → SSG 재확인 후 확정.
              // resolveSsgOrphan 은 내부에 withSsgMutex 가 있어 여기서 호출하면 deadlock.
              // 같은 로직을 mutex-free 로 인라인한다.
              const orphanCandidates = await this.findActiveSsgCandidates(orderDelivery.id);
              const { resolution, confirmedCandidate } = await this.resolveSsgPinCandidates(orphanCandidates);
              if (resolution === SsgPinResolution.CONFIRMED && confirmedCandidate) {
                const confirmed = await this.ssgInsertStateService.markConfirmed(orderDelivery.id, {
                  barCode: confirmedCandidate.barCode,
                  personalCode: confirmedCandidate.personalCode,
                  ssgTransactionId: confirmedCandidate.ssgTransactionId,
                  couponNum: confirmedCandidate.couponNum,
                  expireAt: confirmedCandidate.expireAt,
                  encourageAt: confirmedCandidate.encourageAt,
                  ssgEventId: confirmedCandidate.ssgEventId,
                });
                if (!confirmed) throw new SsgIssueAttemptAlreadyActiveError(orderDelivery.id);
                await this.applyConfirmedCandidate(orderDelivery, confirmedCandidate);
                needsInsert = false;
                return '';
              }

              if (resolution !== SsgPinResolution.NOT_ISSUED) {
                throw new SsgIssueAttemptAlreadyActiveError(orderDelivery.id);
              }

              // 게이트 뒤에서만 markFailed 한다 — markFailed 는 ATTEMPTED 를 풀어 다음 후보의 INSERT 를 여는
              // 실질적 재발급 트리거다(§6-B-3).
              // 남은 시도 흔적(ACTIVE state)을 폐기하고 다시 넣는 것 = 재발급(2차).
              const skippedActiveGate = await this.resolveInsertGate(ssgIssueAuthority, 2);
              if (!skippedActiveGate.allowed) {
                throw new SsgAutoResolveBlockedError(orderDelivery.id, resolution, skippedActiveGate.ordinal);
              }

              const failedOk = await this.ssgInsertStateService.markFailed(orderDelivery.id);
              if (!failedOk) throw new SsgIssueAttemptAlreadyActiveError(orderDelivery.id);
              orderDelivery.barCode = null;
              orderDelivery.personalCode = null;
              orderDelivery.ssgTransactionId = null;
              continue;
            }
            if (markResult === MarkAttemptedResult.SKIPPED_TERMINAL) {
              // CONFIRMED 인데 새 INSERT 호출 = invariant violation. 정상 경로라면 기존 PIN 확인 단계에서 걸렸어야 함.
              throw new SsgIssueAlreadyConfirmedError(orderDelivery.id);
            }

            let response: Awaited<ReturnType<ISsgIssue['issue']>>;
            try {
              await this.assertConsumedSsgIssueAuthority(ssgIssueAuthority);
              response = await this.ssgIssue.issue({
                eventNo: ssgEvent.no,
                eventSeq: ssgEvent.order,
                eventKey: ssgEvent.code,
                vno: orderDelivery.personalCode,
                pinNo: orderDelivery.barCode,
                userName: ssgIssueUserName,
                userAmount: String(orderDelivery.orderProductMapping.product.price),
                msgContent: textForSsg,
                trId: orderDelivery.ssgTransactionId,
                callBack: callBackNumber,
              });
            } catch (e) {
              if (e instanceof SsgIssueRejectedError) {
                // 신세계 거절 확정 → state FAILED 마킹 후 throw (caller가 SSG 행사 잔액 복구 분기 진입 가능).
                await this.ssgInsertStateService.markFailed(orderDelivery.id);
              }
              // 그 외 throw (네트워크/timeout 등) → state ATTEMPTED 유지. orphan resolver 영역.
              throw e;
            }

            // INSERT 성공 → durable state CONFIRMED 마킹 (PIN 정보 best-effort 저장).
            await this.ssgInsertStateService.markConfirmed(orderDelivery.id, {
              barCode: orderDelivery.barCode,
              personalCode: orderDelivery.personalCode,
              ssgTransactionId: orderDelivery.ssgTransactionId,
              couponNum: orderDelivery.couponNum ?? null,
              expireAt: orderDelivery.expireAt ?? null,
              encourageAt: orderDelivery.encourageAt ?? null,
              ssgEventId: ssgEvent.id,
            });

            return JSON.stringify(response);
          }

          throw new Error(`SSG PIN 생성 ${maxRetries}회 시도 후에도 중복 발생`);
        });

        // 신규 INSERT 로 전달된 ssgEvent 를 실제 차감·사용한 경우만 신규발급으로 표시(재사용은 기본 false 유지).
        if (needsInsert) {
          result.ssgNewIssue = true;
          result.ssgEventId = ssgEvent.id;
        }

        // SSG의 SsgCoupon.do는 Oracle INSERT만 수행하며 문자 발송은 하지 않음
        // actualSendAt은 실제 SMS/알림톡 발송 성공 시 delivery.batch.service에서 설정됨
      }

      // 1.1.7 다우기술 PIN 발급
      if (type === 'DAOU') {
        const daouOut = await this.daou.issue({
          goodsId: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
          transactionId: orderDelivery.transactionId,
          phoneNumber: '01000000000', // 개인정보 보호: 더미 번호 사용
          limitDate: String(orderDelivery.orderProductMapping.product.expireDay),
          tradeNo: orderDelivery.transactionId, // tradeNo로 transactionId 사용
        });
        context = JSON.stringify(daouOut);

        // 성공 응답인 경우에만 barCode 설정
        if (daouOut.resultCode === 'S000001' && daouOut.pinNo) {
          orderDelivery.barCode = daouOut.pinNo;
          orderDelivery.couponNum = daouOut.tsId || null; // TS_ID를 couponNum에 저장
        } else {
          throw new Error(daouOut.resultMessage || '다우기술 PIN 발급 실패');
        }
      }

      this.logger.log(orderDelivery.barCode);
      if (!orderDelivery.barCode) {
        throw new Error('barCode not exist');
      }

      // dedup 레코드에 발급된 PIN 기록 (감사용)
      if (type) {
        await this.pinIssueDedupRepository.update(
          { transactionId: orderDelivery.transactionId },
          { barCode: orderDelivery.barCode },
        );
      }

      // PIN 발급 결과를 order_delivery에도 즉시 반영한다. (조기 return 경로들도 반드시 이걸 탄다)
      await this.persistIssuedPin(orderDelivery);
    } catch (e) {
      this.logger.error(e);

      // Error 객체 직렬화 개선 (Error의 message, stack은 non-enumerable이라 JSON.stringify 시 {}가 됨)
      if (e instanceof Error) {
        context = JSON.stringify({ message: e.message, stack: e.stack });
      } else {
        context = JSON.stringify(e);
      }
      isSuccess = false;
      orderDelivery.status = IOrderDeliveryStatus.FAIL;
      if (!orderDelivery.failedAt) {
        orderDelivery.failedAt = new Date();
      }

      // 실패 시 이력을 별도 트랜잭션으로 먼저 저장 (롤백 방지)
      if (type !== null) {
        await this.saveHistoryInNewTransaction(context, isSuccess, type, orderDelivery.id);
      }

      throw e;
    } finally {
      // 성공 시에만 finally에서 이력 저장 (실패 시는 catch에서 이미 저장됨)
      if (type !== null && isSuccess) {
        await this.partnerCompanyExternHistoryRepository.insert({
          context,
          isSuccess,
          type: type!,
          orderDeliveryId: orderDelivery.id,
        });
      }
    }
    return result;
  }

  /** 배치 재발송(resendDeductionId 보유)에서만 pending 을 REUSED 로 durable 마킹. 비-배치 경로는 no-op(빈 tx 회피). */
  private async markReissuePendingReusedIfBatch(resendDeductionId: string | undefined): Promise<void> {
    if (resendDeductionId) {
      await this.markReissuePendingReused(resendDeductionId);
    }
  }

  /**
   * 배치 재발송 선차감 pending 을 'REUSED' 로 durable 마킹 (REQUIRES_NEW 즉시 커밋).
   * issue() 가 기존/후보 PIN 을 재사용해 전달된 ssgEvent(선차감 C)를 미사용한 경우, 재사용 확정 시점에 호출한다.
   * 즉시 커밋되므로 이후 caller 의 직접 역복원 전에 크래시해도 sweep 이 SSG state(재사용 PIN 의 CONFIRMED)와
   * 무관하게 issue_outcome='REUSED' 를 보고 선차감을 REVERSED 한다(이중차감 방지). 미해소 pending 에만 1회.
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  private async markReissuePendingReused(resendDeductionId: string): Promise<void> {
    await this.resendDeductPendingRepository
      .createQueryBuilder()
      .update(SsgResendDeductPendingEntity)
      .set({ issueOutcome: 'REUSED' })
      .where('resend_deduction_id = :rid', { rid: resendDeductionId })
      .andWhere('resolved_at IS NULL')
      .andWhere('issue_outcome IS NULL')
      .execute();
  }

  /**
   * 별도 트랜잭션으로 이력 저장 (메인 트랜잭션 롤백 시에도 이력 유지)
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  private async saveHistoryInNewTransaction(
    context: string,
    isSuccess: boolean,
    type: IPartnerCompanyType,
    orderDeliveryId: number,
  ): Promise<void> {
    await this.partnerCompanyExternHistoryRepository.insert({
      context,
      isSuccess,
      type,
      orderDeliveryId,
    });
  }

  /**
   * 외부 API 전용 취소.
   * 5xx / 네트워크 타임아웃에 한해 1·2·4·8·16초 backoff로 최대 5회 재시도.
   * 4xx 등 비-재시도 에러는 즉시 throw.
   * 멱등성: 협력사 cancel API는 동일 trId 재호출에 안전하다는 가정.
   */
  async cancelByExternalApi(orderDelivery: OrderDeliveryEntity): Promise<CancelCouponResDto> {
    const delays = [1000, 2000, 4000, 8000, 16000];
    const maxAttempts = delays.length;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.cancel(orderDelivery);
      } catch (error: any) {
        if (!this.isRetryableCancelError(error) || attempt === maxAttempts - 1) {
          throw error;
        }
        this.logger.warn(
          `[cancelByExternalApi] 재시도 ${attempt + 1}/${maxAttempts} - delay ${delays[attempt]}ms - ${error?.message ?? error}`,
        );
        await sleep(delays[attempt]);
      }
    }

    // 루프가 항상 throw로 종료되므로 이 줄에 도달하지 않음 (TypeScript 반환 타입 충족용)
    throw new Error('cancelByExternalApi: unreachable');
  }

  private isRetryableCancelError(error: any): boolean {
    const code = error?.code;
    if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNABORTED') {
      return true;
    }
    const status = error?.response?.status ?? error?.status;
    return typeof status === 'number' && status >= 500 && status < 600;
  }

  @Transactional({ propagation: Propagation.REQUIRED })
  async cancel(orderDelivery: OrderDeliveryEntity): Promise<CancelCouponResDto> {
    // 초이스쿠폰의 경우 선택한 상품의 협력사를 우선 사용
    const choicePartnerType = orderDelivery.choiceSelectProduct?.partnerCompany?.type;
    const productPartnerType = orderDelivery.orderProductMapping?.product?.partnerCompany?.type;
    const type = choicePartnerType ?? productPartnerType;

    // 핀 미발급 건(barCode 없음): 외부 API에 등록된 PIN이 없으므로 호출 생략.
    //
    // ★ 이 조기 return 은 이 코드베이스에서 가장 조용한 자금 사고 지점이다 (리뷰 CRITICAL).
    //   전제는 "barCode 가 없다 = 협력사에 핀이 없다" 인데, 그 전제가 깨지는 경로가 있다:
    //     - issue() 의 PIN durable update 가 실패/롤백되면 협력사엔 발급·과금됐는데 우리 DB 만 NULL
    //     - 호출자가 stale 스냅샷(발급 전 값)으로 들어오면 메모리 barCode 가 null
    //   그 상태로 여기 오면 **협력사 취소를 건너뛴 채 "폐기 완료"를 반환**하고, caller 는
    //   그대로 환불을 집행한다 → 협력사엔 살아있는 과금된 핀 + 고객은 환불. 완전 무음이었다.
    //   막지는 못하더라도(진짜 미발급 건도 여기로 온다) **흔적은 반드시 남겨야 한다.**
    if (!orderDelivery.barCode) {
      this.logger.warn(
        `[CANCEL_SKIP] barCode 부재로 협력사 취소 생략 — 발급 롤백/스냅샷 stale 이면 협력사에 ` +
          `살아있는 핀이 남는다(환불은 집행된다). orderDeliveryId=${orderDelivery.id}, ` +
          `transactionId=${orderDelivery.transactionId}, type=${type ?? 'none'}`,
      );
      orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
      return {
        code: '',
        message: '폐기 완료',
      } as CancelCouponResDto;
    }

    // 1.1.1 갤럭시아 쿠폰 발급
    // 표준연동발행규격서 v.1.6.8_갤럭시아머니트리.pdf
    if (type === 'GALAXIA') {
      const giftKind = orderDelivery.orderProductMapping.product.name.includes('(백화점)') ? 'dept' : 'cpn';
      await this.galaxia.cancel({
        transactionId: orderDelivery.transactionId!,
        sendRequestAt: +format(orderDelivery.sendRequestAt, 'yyyyMMdd'),
        giftKind,
        trId: orderDelivery.couponNum!,
      });
    }

    // 1.1.2 GSMBIZ 쿠폰 발급
    // GSM쿠폰_전문사양서_고객사_표준V3.4_20200529.pdf
    if (type === 'GS_M_BIZ') {
      await this.gsmbiz.cancel({
        transactionId: orderDelivery.transactionId!,
        partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
        barCode: orderDelivery.barCode!,
      });
    }

    // 1.1.3 Giftiel 쿠폰 발급
    // giftiel(기프티엘)_공통_판매사_연동가이드_v2.1.0.0_20210409.pdf
    if (type === 'GIFTIEL') {
      await this.giftiel.cancel({
        partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
        barCode: orderDelivery.barCode!,
      });
    }

    // 1.1.4 giftshow 쿠폰 발급
    // 기프티쇼_매체_연동규격서_v1.9.1.2.pdf
    if (type === 'GIFT_SHOW') {
      await this.giftiShow.cancel({
        transactionId: orderDelivery.transactionId!,
      });
    }

    // 1.1.5 컬쳐랜드 쿠폰 발급
    // 컬쳐랜드상품권(모바일문화상품권)_구매_연동가이드_V3.0.pdf
    if (type === 'CULTURELAND') {
      await this.culture.cancel({
        barCode: orderDelivery.barCode!,
        expireDay: orderDelivery.orderProductMapping.product.expireDay,
        certNo: orderDelivery.couponNum!, // cancel 9104 시 check 멱등 검증용
      });
    }

    // 1.1.7 다우기술 쿠폰 취소
    if (type === 'DAOU') {
      await this.daou.cancel({
        pinNo: orderDelivery.barCode!,
      });
    }

    // 1.1.6 신세계 및 없는 type 은 타입만 수정
    orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;

    return {
      code: '',
      message: '폐기 완료',
    } as CancelCouponResDto;
  }

  async refreshCouponStatus(orderDelivery: OrderDeliveryEntity): Promise<OrderDeliveryEntity> {
    // ★ 진입 시점의 coupon_status 를 붙잡아 둔다 — 아래 optimistic CAS 의 대조값.
    //   협력사 조회(외부 통신, 수 초) 동안 아래 분기들이 orderDelivery.couponStatus 를 덮어쓰므로
    //   **반드시 여기서** 캡처해야 한다.
    const loadedCouponStatus = orderDelivery.couponStatus ?? null;

    // 초이스쿠폰의 경우 선택한 상품의 협력사를 우선 확인
    const choicePartnerType = orderDelivery.choiceSelectProduct?.partnerCompany?.type;
    const productPartnerType = orderDelivery.orderProductMapping.product.partnerCompany?.type;
    let partnerType = choicePartnerType ?? productPartnerType;

    if (!partnerType) {
      // TypeORM 깊은 relation 로딩 간헐 실패 대비 — 직접 조회 fallback
      const product = orderDelivery.choiceSelectProduct ?? orderDelivery.orderProductMapping?.product;
      if (!product?.partnerCompanyId) {
        throw new Error(`상품 정보를 찾을 수 없습니다. (orderDeliveryId: ${orderDelivery.id})`);
      }
      const partnerCompany = await this.partnerCompanyRepository.findOne({
        where: { id: product.partnerCompanyId },
      });
      if (!partnerCompany?.type) {
        throw new Error(
          `협력사 정보를 찾을 수 없습니다. (orderDeliveryId: ${orderDelivery.id}, partnerCompanyId: ${product.partnerCompanyId})`,
        );
      }
      this.logger.warn(`partnerCompany relation 로딩 누락 fallback 발동 (orderDeliveryId: ${orderDelivery.id})`);
      partnerType = partnerCompany.type;
    }
    // P5 정산 증적 — SSG 교환 감지 시 아래 CAS+producer same-tx 에서 사용한다.
    let ssgExchangeEvidence: { occurredAt: Date | null; evidenceRef: string } | null = null;

    switch (partnerType) {
      // 1. GALAXIA
      case 'GALAXIA': {
        const baseProduct = orderDelivery.choiceSelectProduct ?? orderDelivery.orderProductMapping.product;

        const giftKind: 'dept' | 'cpn' = baseProduct.name.includes('(백화점)') ? 'dept' : 'cpn';

        const { giftCertificate } = await this.galaxia.check({
          giftKind,
          paramValue: orderDelivery.couponNum!,
        });

        // 잔액형 쿠폰 사용 판정(부분 사용 시 isUsed=false 보정). 상세는 resolveGalaxiaUsage 참고.
        const { balance, isActuallyUsed, fullBalanceRemains } = resolveGalaxiaUsage(giftCertificate);

        // couponStatus: CANCEL > INACTIVE > 사용(부분포함) > validTo 만료 순으로 판단
        if (giftCertificate.couponStatus === 'CANCEL') {
          orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
          orderDelivery.discardedAt = new Date();
        } else if (giftCertificate.couponStatus === 'INACTIVE') {
          // INACTIVE는 자연 만료와 81 환불(End User 직접 환불)이 합쳐져 응답될 수 있음.
          // check API 응답에는 거래구분(appDiv)이 없어 INACTIVE만으로는 환불/만료 구분 불가.
          // 81 로그는 push(또는 daily)로 채워지므로 push 유실 시 비어 있을 수 있다(영구 EXPIRED 오분류).
          // → 유효기간(validTo)을 주신호로 사용: 아직 유효기간이 남았는데 INACTIVE면 자연 만료가
          //   불가능하므로 환불(REFUND_CANCEL)로 본다. 81 로그가 있으면(=push/daily 도착) 그 역시 환불 근거.
          //   둘 중 하나라도 성립하면 REFUND_CANCEL, 아니면(유효기간 지남 & 81 로그 없음) 만료.
          const stillValid = !!giftCertificate.validTo && !isExpiredYMD(giftCertificate.validTo);
          const has81Refund = await this.galaxiaBarcodeLogRepository.existsBy({
            orderDeliveryId: orderDelivery.id,
            appDiv: '81',
          });
          if (stillValid || has81Refund) {
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.REFUND_CANCEL;
            if (!orderDelivery.discardedAt) {
              orderDelivery.discardedAt = new Date();
            }
          } else {
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.EXPIRED;
          }
        } else if (isActuallyUsed) {
          orderDelivery.couponStatus = OrderDeliveryCouponStatus.USED;
        } else if (isExpiredYMD(giftCertificate.validTo)) {
          orderDelivery.couponStatus = OrderDeliveryCouponStatus.EXPIRED;
        } else {
          orderDelivery.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
        }
        // 교환 일시/장소: 실제 사용액이 있을 때만 유지. 전액 잔존(미사용/사용취소) 시 비운다.
        if (fullBalanceRemains) {
          orderDelivery.tradeAt = null;
          orderDelivery.tradePlace = null;
        } else {
          orderDelivery.tradeAt = parseDateString(giftCertificate.usedDate);
        }
        orderDelivery.galaxiaBalance = balance;
        break;
      }

      // 2. GS_M_BIZ
      case 'GS_M_BIZ': {
        const partnerCompanyCode =
          orderDelivery.choiceSelectProduct?.partnerCompanyCode ??
          orderDelivery.orderProductMapping.product.partnerCompanyCode!;

        const { couponInfo } = await this.gsmbiz.check({
          transactionId: orderDelivery.transactionId!,
          partnerCompanyCode,
          barCode: orderDelivery.barCode!,
        });

        orderDelivery.couponStatus =
          couponInfo.STATE === '10' ? OrderDeliveryCouponStatus.USED : OrderDeliveryCouponStatus.NOT_USED;
        orderDelivery.tradeAt = couponInfo.USE_DT ? new Date(couponInfo.USE_DT) : null;
        break;
      }

      // 3. GIFTIEL
      case 'GIFTIEL': {
        const partnerCompanyCode =
          orderDelivery.choiceSelectProduct?.partnerCompanyCode ??
          orderDelivery.orderProductMapping.product.partnerCompanyCode!;

        const giftielOut = await this.giftiel.check({
          partnerCompanyCode,
          barCode: orderDelivery.barCode!,
        });

        if (giftielOut.UseYn === 'Y') {
          orderDelivery.couponStatus = OrderDeliveryCouponStatus.USED;
          const latestPush = await this.giftielExchangeHistoryRepository.findOne({
            where: { orderDeliveryId: orderDelivery.id },
            order: { authDate: 'DESC' },
          });
          if (latestPush?.cmdType !== 'L1') {
            orderDelivery.tradeAt = giftielOut.UseDate
              ? parseDateString(giftielOut.UseDate.replace(/[-:\s]/g, ''))
              : null;
            orderDelivery.tradePlace = giftielOut.BiName || null;
          }
        } else {
          // GIFTIEL은 만료 상태를 별도로 내려주지 않으므로 DayEnd(yyyy-MM-dd)로 보정
          const dayEndYMD = giftielOut.DayEnd?.replace(/-/g, '');
          orderDelivery.couponStatus =
            dayEndYMD && isExpiredYMD(dayEndYMD)
              ? OrderDeliveryCouponStatus.EXPIRED
              : OrderDeliveryCouponStatus.NOT_USED;
          orderDelivery.tradeAt = null;
          orderDelivery.tradePlace = null;
        }
        break;
      }

      // 4. GIFT_SHOW (V2 API)
      case 'GIFT_SHOW': {
        const giftiShowOut = await this.giftiShow.check({
          transactionId: orderDelivery.transactionId!,
        });

        if (giftiShowOut.resCode !== '0000' || !giftiShowOut.couponInfo) {
          throw new Error(`GiftiShow API 오류: ${giftiShowOut.resCode} - ${giftiShowOut.resMsg}`);
        }

        const { pinStatusCd, exchDtm, tradeBranchNm, branchNm, useComNm } = giftiShowOut.couponInfo;

        // pinStatusCd: 01=발행, 02=교환, 07=취소, 08=만료, 11=잔액기간만료(일부 사용 후 잔액 만료)
        switch (pinStatusCd) {
          case '01':
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
            break;
          case '02':
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.USED;
            if (exchDtm) {
              orderDelivery.tradeAt = parseDateString(exchDtm);
            }
            // 교환장소: tradeBranchNm > branchNm > useComNm 순으로 사용
            orderDelivery.tradePlace = tradeBranchNm || branchNm || useComNm || null;
            break;
          case '11':
            // 잔액기간만료: 사용 이력(exchDtm)이 있으면 교환, 없으면 만료
            if (exchDtm) {
              orderDelivery.couponStatus = OrderDeliveryCouponStatus.USED;
              orderDelivery.tradeAt = parseDateString(exchDtm);
              orderDelivery.tradePlace = tradeBranchNm || branchNm || useComNm || null;
            } else {
              orderDelivery.couponStatus = OrderDeliveryCouponStatus.EXPIRED;
            }
            break;
          case '07':
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
            orderDelivery.discardedAt = new Date();
            break;
          case '08':
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.EXPIRED;
            break;
          default:
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
        }
        break;
      }

      // 5. CULTURELAND
      case 'CULTURELAND': {
        const expireDay =
          orderDelivery.choiceSelectProduct?.expireDay ?? orderDelivery.orderProductMapping.product.expireDay;

        const cultureLandOut = await this.culture.check({
          scrachNo: orderDelivery.barCode!,
          certNo: orderDelivery.couponNum!, // 상품권 관리번호
          requestAt: orderDelivery.sendRequestAt!,
          expireDay,
        });

        // ResultCode 9006: 유효기간 만료된 상품권
        // ResultCode 9003: 잘못된 상품권 번호 → 컬쳐랜드 측에서 더 이상 조회되지 않는 상태
        //   = 취소 완료 후 제거된 상품권으로 간주 (취소 처리 시 별도 "취소됨" 응답 코드가 없는
        //   컬쳐랜드 API 특성상 9003 을 CANCEL 시그널로 매핑)
        if (cultureLandOut.ResultCode === '9006') {
          // 만료 응답(9006)엔 사용여부 정보가 없다(FaceValue/Balance/CancelPossibility 빈값).
          // 이미 확정된 terminal(USED/CANCEL/REFUND_CANCEL) 상태는 만료가 덮어쓰지 않는다.
          const isTerminal =
            orderDelivery.couponStatus === OrderDeliveryCouponStatus.USED ||
            orderDelivery.couponStatus === OrderDeliveryCouponStatus.CANCEL ||
            orderDelivery.couponStatus === OrderDeliveryCouponStatus.REFUND_CANCEL;
          if (!isTerminal) {
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.EXPIRED;
          }
        } else if (cultureLandOut.ResultCode === '9003') {
          orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
          if (!orderDelivery.discardedAt) {
            orderDelivery.discardedAt = new Date();
          }
        } else if (cultureLandOut.ResultCode === '0000') {
          const isUsed = cultureLandOut.CancelPossibility === 'N';
          orderDelivery.couponStatus = isUsed ? OrderDeliveryCouponStatus.USED : OrderDeliveryCouponStatus.NOT_USED;
          // 컬쳐랜드 check API는 사용일시를 제공하지 않으므로
          // 첫 USED 전환 시점만 기록하고, 이후 재조회로 갱신하지 않는다
          if (isUsed && !orderDelivery.tradeAt) {
            orderDelivery.tradeAt = new Date();
          }
        } else {
          this.logger.warn(
            `CULTURELAND check 실패 - ResultCode: ${cultureLandOut.ResultCode}, ErrMsg: ${cultureLandOut.ErrMsg}`,
          );
        }
        break;
      }

      // SSG
      case 'SSG': {
        // SSG는 폐기 정보가 연동 DB(CUST_INFO_RESULT)에 반영되지 않음
        // 이미 폐기된 쿠폰은 상태조회 시 상태를 변경하지 않음
        if (
          orderDelivery.couponStatus === OrderDeliveryCouponStatus.CANCEL ||
          orderDelivery.couponStatus === OrderDeliveryCouponStatus.REFUND_CANCEL
        ) {
          break;
        }

        if (!orderDelivery.ssgEvent) {
          throw new Error('ssgEvent not loaded on orderDelivery');
        }
        if (!orderDelivery.personalCode) {
          throw new Error('personalCode is null');
        }

        const ssgOut = await this.ssgIssue.check({
          eventNo: orderDelivery.ssgEvent.no,
          eventSeq: orderDelivery.ssgEvent.order,
          vno: orderDelivery.personalCode,
        });

        const resultCd = ssgOut.response.value[0].resultCd[0];
        const isExchanged = resultCd === '0400';
        if (isExchanged) {
          orderDelivery.couponStatus = OrderDeliveryCouponStatus.USED;
        } else if (orderDelivery.expireAt && isExpiredYMD(formatDateYMD(orderDelivery.expireAt))) {
          orderDelivery.couponStatus = OrderDeliveryCouponStatus.EXPIRED;
        } else {
          orderDelivery.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
        }

        // 교환 완료 시 교환장소(payaccntNm)와 교환일시(executeDate) 저장
        if (isExchanged) {
          const payaccntNm = ssgOut.response.value[0].payaccntNm?.[0];
          const executeDate = ssgOut.response.value[0].executeDate?.[0];

          if (payaccntNm && payaccntNm.trim()) {
            orderDelivery.tradePlace = payaccntNm.trim();
          }
          if (executeDate) {
            orderDelivery.tradeAt = new Date(executeDate);
          }

          // P5 정산 증적 수집 — CAS 성공 후 producer 에서 사용한다.
          ssgExchangeEvidence = {
            occurredAt: orderDelivery.tradeAt ?? null,
            evidenceRef: `${orderDelivery.ssgEvent.no}|${orderDelivery.ssgEvent.order}|${orderDelivery.personalCode}`,
          };
        }
        break;
      }

      // 7. DAOU
      case 'DAOU': {
        const daouCheckOut = await this.daou.check({
          barCode: orderDelivery.barCode ?? undefined,
          transactionId: orderDelivery.transactionId ?? undefined,
        });

        // 응답 코드 확인
        if (daouCheckOut.resultCode === 'S000001') {
          // CPN_STATUS: 00(미사용), 01(교환완료), 02(기취소), 03(사용중)
          if (daouCheckOut.cpnStatus === '00') {
            // DAOU는 만료 상태를 별도로 내려주지 않으므로 CPN_END로 보정
            orderDelivery.couponStatus =
              daouCheckOut.cpnEnd && isExpiredYMD(daouCheckOut.cpnEnd)
                ? OrderDeliveryCouponStatus.EXPIRED
                : OrderDeliveryCouponStatus.NOT_USED;
          } else if (daouCheckOut.cpnStatus === '01' || daouCheckOut.cpnStatus === '03') {
            // 01: 교환완료, 03: 사용중 - 둘 다 USED로 처리
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.USED;
            orderDelivery.tradeAt = parseDateString(daouCheckOut.useDate);
            // 사용처가 있으면 tradePlace에 설정
            if (daouCheckOut.useBranch) {
              orderDelivery.tradePlace = daouCheckOut.useBranch;
            }
          } else if (daouCheckOut.cpnStatus === '02') {
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
            orderDelivery.discardedAt = new Date();
          }
        } else {
          throw new Error(`DAOU 쿠폰 상태 조회 실패: ${daouCheckOut.resultMessage}`);
        }
        break;
      }

      // 기타
      default:
        throw new Error(`Unsupported partnerCompany type: ${partnerType}`);
    }

    // 저장 — save(orderDelivery) 금지 (D3-55/D3-60).
    //
    // ★ mutation_claimed_at 은 **컬럼**이고, save()=merge 는 **행 전체**를 쓴다.
    //   이 메서드의 스냅샷은 협력사 조회(외부 통신, 수 초) **전에** 로드된 것이라
    //   mutation_claimed_at=null 이 굳어 있다. 그 사이 폐기·재발행이 lease 를 잡으면
    //   여기 save 가 **남의 살아있는 lease 를 NULL 로 지운다**:
    //     - 진행 중인 재발행의 fenced write 가 affected=0 → 운영자에게 409("다른 작업이 선점")
    //       — 실제로는 아무도 선점하지 않았는데.
    //     - lease 가 사라져 폐기×재발행 교차 창이 **다시 열린다**(이 작업이 닫으려던 그 창).
    //
    // 이 메서드가 엔티티에 쓰는 컬럼은 아래 5개가 전부다(전수 확인: 협력사별 분기 전 구간).
    //
    // ★ 그리고 **optimistic CAS** 가 필요하다 (리뷰 HIGH, 양쪽 일치).
    //   lease 컬럼 clobber 는 위로 막혔지만 coupon_status 축(D3-60 의 본체)은 여전히 열려 있었다:
    //     T0: 운영자 A 가 "핀상태갱신" → 협력사 check 호출(수 초). 응답 NOT_USED.
    //     T1: 운영자 B 가 폐기 → lease 획득 → 협력사 cancel → coupon_status=CANCEL → 환불 집행.
    //     T2: A 의 update 착지 → coupon_status=NOT_USED, discarded_at=NULL (스냅샷 stale 값)
    //         → **환불된 죽은 쿠폰이 DB 상 되살아나고 폐기 시각까지 지워진다.**
    //         → UNSENDABLE_COUPON_STATUSES 게이트를 통과 → 배치/CS 재전송이 그 핀을 배달.
    //   폐기 쪽은 lease 를 정상적으로 잡았고 아무 잘못이 없다. 이 update 가 무조건부였을 뿐이다.
    //
    //   막는 법 — **진입 시점 값에서 변하지 않았을 때만 쓴다**(optimistic CAS).
    //   lease 술어(mutation_claimed_at IS NULL)를 쓰면 안 된다: syncCouponStatusAfterDiscardFailure
    //   는 **자기 lease 를 쥔 채** 이 메서드를 부르므로 자기 쓰기를 스스로 막게 된다
    //   (b90abcb 에서 이미 밟은 지뢰다).
    //   "터미널 다운그레이드 금지" 도 안 된다: 폐기 실패 후 동기화(CANCEL → 실제 NOT_USED 정정)라는
    //   **정당한 다운그레이드**가 실재하고, 그걸 막으면 살아있는 쿠폰이 DB 상 죽은 채로 굳는다.
    //   진입 시점 값 대조는 그 둘을 정확히 가른다.

    // P5 SSG 정산: isSettlementTarget 이면 CAS + producer 를 같은 트랜잭션으로 묶는다(§6.5).
    // flag off 경로는 기존 CAS 단독 실행과 1비트도 다르지 않다(§4.6 회귀 요건).
    const provider = partnerType as IPartnerCompanyType;
    const needsSsgSettlement = !!ssgExchangeEvidence && this.settleFlag.isEnabledFor(provider);

    const executeCasWrite = () =>
      this.orderDeliveryRepository
        .createQueryBuilder()
        .update(OrderDeliveryEntity)
        .set({
          couponStatus: orderDelivery.couponStatus,
          discardedAt: orderDelivery.discardedAt,
          tradeAt: orderDelivery.tradeAt,
          tradePlace: orderDelivery.tradePlace,
          galaxiaBalance: orderDelivery.galaxiaBalance,
        })
        .where('id = :id', { id: orderDelivery.id })
        // NULL-safe equality(<=>) — coupon_status 가 NULL 인 행도 정상 대조된다.
        .andWhere('coupon_status <=> :loaded', { loaded: loadedCouponStatus })
        .execute();

    const handleCasResult = (affected: number | undefined) => {
      if (!affected) {
        this.logger.error(
          `[핀상태갱신] 조회 중 쿠폰상태가 변경됨 — 갱신을 폐기한다(stale 덮어쓰기 방지). ` +
            `orderDeliveryId=${orderDelivery.id}, 진입시=${loadedCouponStatus}, 협력사응답=${orderDelivery.couponStatus}`,
        );
      }
      return !!affected;
    };

    if (needsSsgSettlement) {
      await runInTransaction(async () => {
        const write = await executeCasWrite();
        if (!handleCasResult(write.affected)) return;

        const ctx = buildSettlementContext(orderDelivery, provider);
        if (!ctx || !this.settleProducer.isSettlementTarget(ctx, 'EXCHANGE')) return;

        const ev = ssgExchangeEvidence!;
        await this.settleProducer.record(ctx, {
          kind: 'EXCHANGE',
          idempotencyKey: buildProviderTransitionKey(IPartnerCompanyType.SSG, 'EXCHANGE', ev.evidenceRef),
          occurredAt: ev.occurredAt ? fromDate(ev.occurredAt) : null,
          baseAmount:
            orderDelivery.orderProductMapping?.snapshotProductPrice != null
              ? BigInt(orderDelivery.orderProductMapping.snapshotProductPrice)
              : null,
          providerEvidenceRef: ev.evidenceRef,
        });
      });
    } else {
      const write = await executeCasWrite();
      handleCasResult(write.affected);
    }
    return orderDelivery;
  }

  /**
   * SSG orphan resolver — ATTEMPTED state row의 실제 등록 여부 확정.
   * plans/ssg-balance-refactor.md PR2.
   *
   * orderDelivery.id 기준 `ssg_issue_log` 후보를 최신순으로 lookup 하고, 각 후보에 대해
   * SSG `check` API 호출. 등록된 PIN 발견 시 `markConfirmed`, 모두 NotFound 면 `markFailed`.
   *
   * 안전 정책:
   * - check 도중 네트워크/파싱 오류 발생 → `NETWORK_UNKNOWN` 반환 (ATTEMPTED 유지, FAILED 마킹 X)
   * - eventSeq 가 NULL 인 legacy ssg_issue_log row → skip (check 호출 파라미터 불완전)
   * - 입력 state 가 ATTEMPTED 가 아니면 즉시 SKIPPED_NOT_ATTEMPTED 반환
   *
   * PR3 refund resolver 및 재발송 가드가 caller. 결과에 따라 SSG 행사 잔액 분기 결정.
   */
  async resolveSsgOrphan(orderDeliveryId: number): Promise<SsgOrphanResolveOutcome> {
    const currentState = await this.ssgInsertStateService.getState(orderDeliveryId);
    if (currentState !== SsgInsertState.ATTEMPTED) {
      return SsgOrphanResolveOutcome.SKIPPED_NOT_ATTEMPTED;
    }

    const candidates = await this.findActiveSsgCandidates(orderDeliveryId);
    if (candidates.length === 0) {
      return SsgOrphanResolveOutcome.NETWORK_UNKNOWN;
    }

    const { resolution, confirmedCandidate } = await this.withSsgMutex(() => this.resolveSsgPinCandidates(candidates));
    if (resolution === SsgPinResolution.CONFIRMED && confirmedCandidate) {
      const transitioned = await this.ssgInsertStateService.markConfirmed(orderDeliveryId, {
        barCode: confirmedCandidate.barCode,
        personalCode: confirmedCandidate.personalCode,
        ssgTransactionId: confirmedCandidate.ssgTransactionId,
        couponNum: confirmedCandidate.couponNum,
        expireAt: confirmedCandidate.expireAt,
        encourageAt: confirmedCandidate.encourageAt,
        ssgEventId: confirmedCandidate.ssgEventId,
      });
      return transitioned ? SsgOrphanResolveOutcome.CONFIRMED : SsgOrphanResolveOutcome.NETWORK_UNKNOWN;
    }

    if (resolution === SsgPinResolution.NOT_ISSUED) {
      // EP-P30 §6-B-3 — 판정기 재작성만으로 환불·state 전이가 살아나지 않도록 게이트 뒤에 둔다.
      // `tryYn='N'` 만으로 행사 잔액을 복구하려면 §4-2 의 코드 계약(8021·0103)이 먼저 확정돼야 한다.
      if (!SSG_AUTORESOLVE_PHASE.REFUND_ON_NOT_ISSUED) {
        this.logger.warn(
          `[SSG][P30] NOT_ISSUED 판정이나 환불 경로는 미개방 — ATTEMPTED 유지. orderDeliveryId=${orderDeliveryId}`,
        );
        return SsgOrphanResolveOutcome.NETWORK_UNKNOWN;
      }
      const transitioned = await this.ssgInsertStateService.markFailed(orderDeliveryId);
      return transitioned ? SsgOrphanResolveOutcome.FAILED : SsgOrphanResolveOutcome.NETWORK_UNKNOWN;
    }

    // LOOKUP_FAILED, REGISTERED_UNSENDABLE, UNKNOWN, and MULTIPLE_CONFIRMED retain ATTEMPTED.
    // They never select, reissue, send, or refund from partial evidence.
    return SsgOrphanResolveOutcome.NETWORK_UNKNOWN;
  }

  /**
   * P1 정산 원장 — 발행분 ISSUANCE.
   *
   * flag off 면 즉시 리턴(DB 접근 0). flag on 이면 조인 재조회 → producer.record.
   * persistIssuedPin 의 REQUIRES_NEW 안에서 호출되므로 same-tx(§6.5).
   */
  private async recordIssuanceSettlement(orderDelivery: OrderDeliveryEntity): Promise<void> {
    // 조인 데이터 없이 provider 를 판정할 수 없으므로 전역 flag 만 먼저 검사한다.
    if (!this.settleFlag.isEnabled) return;

    const od = await this.orderDeliveryRepository.findOne({
      where: { id: orderDelivery.id },
      relations: [
        'orderProductMapping',
        'orderProductMapping.product',
        'orderProductMapping.product.partnerCompany',
        'choiceSelectProduct',
        'choiceSelectProduct.partnerCompany',
      ],
    });
    if (!od) return;

    const provider = (od.choiceSelectProduct?.partnerCompany?.type ??
      od.orderProductMapping?.product?.partnerCompany?.type) as IPartnerCompanyType | undefined;
    if (!provider || !this.settleFlag.isEnabledFor(provider)) return;

    const ctx = buildSettlementContext(od, provider);
    if (!ctx) return;

    await this.settleProducer.record(ctx, {
      kind: 'ISSUANCE',
      idempotencyKey: buildIssuanceKey(od.id),
      occurredAt: fromDate(new Date()),
      baseAmount:
        od.orderProductMapping?.snapshotProductPrice != null
          ? BigInt(od.orderProductMapping.snapshotProductPrice)
          : null,
    });
  }
}
