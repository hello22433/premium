import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PartnerProviderEventInboxEntity } from '../../entity/partner.provider.event.inbox.entity';
import { PartnerSettleTransitionObservationEntity } from '../../entity/partner.settle.transition.observation.entity';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { IPartnerSettleSourceType } from '../interface/partner.settle.source.type';
import { IPartnerProviderEventOrigin } from '../interface/partner.provider.event.status';
import { buildInboxEvidenceKey } from '../domain/settle.idempotency.key';
import { KstInstant, toDbDateTimeString } from '../domain/settle.time';
import { insertRawRow, RawRow } from './partner.settle.raw.insert';
import { PartnerSettleObservationService } from './partner.settle.observation.service';

/**
 * provider 원천 관측/orphan inbox (정본 §5.12 · PR1B 명세 B11·B12).
 *
 * 두 lane 이 한 테이블에 있고 **서로의 규칙을 절대 침범하지 않는다**.
 * - 관측 lane(`POLL|PUSH|MANUAL`): snapshot 만 주는 provider(다우 등)의 재발 전이를 적재한다.
 *   row id 가 곧 `unresolvedEvidenceKey = INBOX:{id}` 다. payload fingerprint 를 evidence 로 쓰면
 *   같은 날 사용→취소→재사용에서 두 번째 사건이 UNIQUE 에 삼켜진다(48차-B1).
 * - orphan lane(`ORPHAN`): 시각 누락처럼 자동 원장화가 불가능한 확정 사건을 적재한다.
 *   **observation 을 만들지 않는다** — 전이 시퀀스가 아니라 확정 사건이기 때문이다.
 *
 * 모든 경로는 호출부가 `order_delivery FOR UPDATE` 를 잡은 트랜잭션 안에서 부른다.
 */

/** 동시 ingress 수렴으로 삼켜도 되는 UNIQUE. 관측 lane 은 이 제약 대상이 아니라 목록이 비어 있다. */
const INBOX_INGRESS_CONSTRAINT = 'uk_partner_provider_event_inbox_ingress';

export type ObservationLaneInput = {
  provider: IPartnerCompanyType;
  orderDeliveryId: number;
  sourceType: IPartnerSettleSourceType;
  /** 자동 수신만 이 경로를 쓴다. MANUAL 발급(PR1C)은 no-op 규칙을 쓰지 않는다 */
  origin: Extract<IPartnerProviderEventOrigin, 'POLL' | 'PUSH'>;
  normalizedPayload: Record<string, unknown>;
  /** 시각 포함 payload 정규화 hash — append/dedup 판정용 */
  payloadFingerprint: string;
  observedStatus: string;
  observedAt: KstInstant;
  /** observation 에 실을 전이 표기 */
  prevStatus: string;
  runId?: string | null;
};

export type OrphanIngressInput = {
  provider: IPartnerCompanyType;
  orderDeliveryId: number;
  sourceType: IPartnerSettleSourceType;
  normalizedPayload: Record<string, unknown>;
  payloadFingerprint: string;
  /** **시각 제외** 비시각 정규화 hash. 동일 malformed 재수신을 1 row 로 수렴시킨다 */
  ingressFingerprint: string;
  observedStatus: string;
  observedAt: KstInstant;
};

export type ObservationLaneResult = {
  inboxRow: PartnerProviderEventInboxEntity;
  observation: PartnerSettleTransitionObservationEntity | null;
  /** 신규 관측이면 true, 무변화 재조회(no-op)면 false */
  appended: boolean;
};

const OBSERVATION_LANE_ORIGINS: IPartnerProviderEventOrigin[] = ['POLL', 'PUSH', 'MANUAL'];

@Injectable()
export class PartnerProviderEventInboxService {
  constructor(
    @InjectRepository(PartnerProviderEventInboxEntity)
    private readonly inboxRepository: Repository<PartnerProviderEventInboxEntity>,
    private readonly observationService: PartnerSettleObservationService,
  ) {}

  /** 잠금 순서상 inbox 접근 전에 잡아야 하는 발송건 잠금. */
  async lockDelivery(orderDeliveryId: number): Promise<void> {
    await this.inboxRepository.query('SELECT id FROM order_delivery WHERE id = ? FOR UPDATE', [orderDeliveryId]);
  }

  /**
   * 관측 lane append/dedup (§5.12 ①~⑥ canonical 순서).
   *
   * ② 관측 lane 최신 row 조회 → ③ `PENDING` 이면 payload 비교 **전에** 복구·`LINKED` 후 재평가
   * → ④ 동일 `(observedStatus, payloadFingerprint)` 면 no-op → ⑤ 신규 `PENDING` append
   * → ⑥ observation 생성 후 `LINKED` CAS.
   *
   * ③ 을 ④ 뒤로 미루면 append 후 crash 로 남은 PENDING 이 현재 payload 와 같을 때 영원히 복구되지 않는다.
   * 루프는 복구 대상이 최대 1건이라 유계다.
   */
  async observe(input: ObservationLaneInput): Promise<ObservationLaneResult> {
    let latest = await this.findLatestObservationLaneRow(input.provider, input.orderDeliveryId);

    if (latest && latest.processedStatus === 'PENDING') {
      // crash 복구 — 먼저 밀린 관측을 observation 으로 연결하고 나서 현재 payload 를 다시 본다.
      await this.linkObservation(latest, input);
      latest = await this.findLatestObservationLaneRow(input.provider, input.orderDeliveryId);
    }

    if (
      latest &&
      latest.observedStatus === input.observedStatus &&
      latest.payloadFingerprint === input.payloadFingerprint
    ) {
      // 무변화 재조회는 신규 row 를 만들지 않는다. 만들면 재스캔마다 관측이 늘어 evidence 가 의미를 잃는다.
      return { inboxRow: latest, observation: null, appended: false };
    }

    const appended = await this.appendObservationRow(input, latest?.id ?? null);
    const observation = await this.linkObservation(appended, input);

    return { inboxRow: appended, observation, appended: true };
  }

  /**
   * orphan lane ingress (§5.12 ①~④).
   *
   * 같은 `(provider, orderDeliveryId, ingressFingerprint)` 는 1 row 로 수렴한다. observation·transition 은
   * 만들지 않는다 — orphan 은 전이 시퀀스가 아니라 시각만 없는 확정 사건이다.
   */
  async ingressOrphan(
    input: OrphanIngressInput,
  ): Promise<{ inboxRow: PartnerProviderEventInboxEntity; appended: boolean }> {
    const existing = await this.findOrphanByIngress(
      input.provider,
      input.orderDeliveryId,
      input.ingressFingerprint,
    );
    if (existing) return { inboxRow: existing, appended: false };

    const { duplicated } = await insertRawRow(
      this.inboxRepository,
      'partner_provider_event_inbox',
      {
        ...this.commonColumns(input),
        origin: 'ORPHAN',
        ingress_fingerprint: input.ingressFingerprint,
        prev_inbox_row_id: null,
        observation_id: null,
        processed_status: 'ORPHAN_PENDING',
      },
      { idempotentConstraints: [INBOX_INGRESS_CONSTRAINT] },
    );

    const saved = await this.findOrphanByIngress(
      input.provider,
      input.orderDeliveryId,
      input.ingressFingerprint,
    );
    if (!saved) {
      throw new InternalServerErrorException('orphan inbox 적재 결과를 다시 읽지 못했습니다.');
    }
    // UNIQUE 충돌은 동시 수신이 같은 malformed event 를 집은 것이다. 그 경우도 결과는 1 row 수렴이다.
    return { inboxRow: saved, appended: !duplicated };
  }

  /**
   * 시각이 완비된 동일 사건이 도착했을 때 자동 producer 가 orphan row 를 선점한다(63차-H1).
   *
   * **원장 append 전에** 해야 한다. 생략하면 이후 PR1C 수동 승인이 같은 사건을 다시 원장화해 중복정산된다.
   * CAS 라 두 producer 가 동시에 들어와도 한쪽만 true 를 받는다.
   */
  async claimOrphanForAutoLedger(inboxRowId: number): Promise<boolean> {
    const result = await this.inboxRepository.update(
      { id: inboxRowId, processedStatus: 'ORPHAN_PENDING' },
      { processedStatus: 'ORPHAN_AUTO_LEDGERED' },
    );
    return result.affected === 1;
  }

  /** 관측 lane 최신 row. `origin='ORPHAN'` 은 이 조회·복구·no-op 판정 대상이 아니다(61차). */
  private findLatestObservationLaneRow(
    provider: IPartnerCompanyType,
    orderDeliveryId: number,
  ): Promise<PartnerProviderEventInboxEntity | null> {
    return this.inboxRepository.findOne({
      where: { provider, orderDeliveryId, origin: In(OBSERVATION_LANE_ORIGINS) },
      order: { id: 'DESC' },
    });
  }

  private findOrphanByIngress(
    provider: IPartnerCompanyType,
    orderDeliveryId: number,
    ingressFingerprint: string,
  ): Promise<PartnerProviderEventInboxEntity | null> {
    return this.inboxRepository.findOne({
      where: { provider, orderDeliveryId, ingressFingerprint },
    });
  }

  private async appendObservationRow(
    input: ObservationLaneInput,
    prevInboxRowId: number | null,
  ): Promise<PartnerProviderEventInboxEntity> {
    // 관측 lane 은 ingress_fingerprint NULL 이라 어떤 UNIQUE 에도 걸리지 않는다. 여기서 1062 가 나면
    // 그건 수렴이 아니라 버그이므로 멱등 목록을 비워 그대로 올린다.
    await insertRawRow(
      this.inboxRepository,
      'partner_provider_event_inbox',
      {
        ...this.commonColumns(input),
        origin: input.origin,
        ingress_fingerprint: null,
        prev_inbox_row_id: prevInboxRowId,
        observation_id: null,
        processed_status: 'PENDING',
      },
      { idempotentConstraints: [] },
    );

    const appended = await this.findLatestObservationLaneRow(input.provider, input.orderDeliveryId);
    if (!appended) {
      throw new InternalServerErrorException('관측 inbox 적재 결과를 다시 읽지 못했습니다.');
    }
    return appended;
  }

  /**
   * observation 생성 + `PENDING → LINKED` 1회 CAS.
   *
   * evidence 는 **inbox row id** 다. payload fingerprint 를 쓰면 같은 날 재발 사건이 UNIQUE 에 삼켜진다.
   */
  private async linkObservation(
    row: PartnerProviderEventInboxEntity,
    input: ObservationLaneInput,
  ): Promise<PartnerSettleTransitionObservationEntity> {
    const observation = await this.observationService.recordUnresolved({
      provider: row.provider,
      orderDeliveryId: row.orderDeliveryId,
      sourceType: row.sourceType,
      prevStatus: input.prevStatus,
      newStatus: row.observedStatus,
      observedAt: input.observedAt,
      evidenceKey: buildInboxEvidenceKey(row.id),
      runId: input.runId,
    });

    await this.inboxRepository.update(
      { id: row.id, processedStatus: 'PENDING' },
      { processedStatus: 'LINKED', observationId: observation.id },
    );
    row.processedStatus = 'LINKED';
    row.observationId = observation.id;

    return observation;
  }

  private commonColumns(input: {
    provider: IPartnerCompanyType;
    orderDeliveryId: number;
    sourceType: IPartnerSettleSourceType;
    normalizedPayload: Record<string, unknown>;
    payloadFingerprint: string;
    observedStatus: string;
    observedAt: KstInstant;
  }): RawRow {
    return {
      provider: input.provider,
      order_delivery_id: input.orderDeliveryId,
      source_type: input.sourceType,
      normalized_payload: JSON.stringify(input.normalizedPayload),
      payload_fingerprint: input.payloadFingerprint,
      observed_status: input.observedStatus,
      // 관측 시각도 canonical 문자열로 저장한다(Date 경유 시 마이크로초 유실).
      observed_at: toDbDateTimeString(input.observedAt),
      manual_proposal_id: null,
      manual_ledger_proposal_id: null,
    };
  }
}
