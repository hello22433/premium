import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PinIssueCommandEntity } from '../../entity/pin.issue.command.entity';
import { PinIssueCommandStatus } from '../../delivery/interface/pin.issue.command.status';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { PartnerCompanyExternService } from './partner.company.extern.service';
import { SsgAutoResolveMode, resolveSsgAutoResolveCapability } from '../domain/ssg.autoresolve.policy';
import { SsgAutoResolveConfig } from './ssg.autoresolve.config';
import { SsgPinObservationService } from './ssg.pin.observation.service';

/**
 * EP-P30 §9-3 관측 sweep — **운영 흐름과 완전히 분리된 독립 observer** 다.
 *
 * 관측을 판정 소비자(`resolvePinIssuesOnce`) 안에 붙이면 두 가지가 깨진다:
 *  1. 관측하려면 먼저 claim 해야 한다 → `observe` 모드가 command ownership·delivery claim 을
 *     바꾼다. "durable 전이 0" 이라는 observe 의 정의 자체가 무너진다.
 *  2. sweep 은 'N' 을 한 번 보면 그 command 를 OPS_REVIEW_REQUIRED 로 보내 due 목록에서 뺀다
 *     → 서로 다른 버킷의 연속 표본(§5-4 연속 3회 근거)을 영원히 모을 수 없다.
 *
 * 그래서 여기서는 claim 하지 않고, 상태를 바꾸지 않고, PIN 을 복원하지 않는다.
 * 순수 판정(`classifyDeferredSsgIssue`) + 관측 저장뿐이다. 같은 command 를 매 주기 다시 읽으므로
 * OPS_REVIEW_REQUIRED 로 넘어간 뒤에도 표본이 계속 쌓인다.
 */
@Injectable()
export class SsgPinObservationSweepService {
  private readonly logger = new Logger('SSG_PIN_OBSERVATION');

  /** 한 주기 관측 상한. 후보마다 SSG 조회가 붙으므로 운영 sweep(100)보다 보수적으로 잡는다. */
  static readonly OBSERVE_LIMIT = 50;

  /**
   * 관측 진입 최소 체류시간. 발급 진행 중인 command 를 읽으면 ssg_issue_log 가 아직 없어
   * "미시도(NOT_ATTEMPTED)" 로 기록된다 — 사실은 '아직'이다. 이 표본이 섞이면 §5-4 모수가 깨진다.
   */
  static readonly MIN_DWELL_MS = 5 * 60_000;

  /**
   * 관측 대상 = 아직 확정되지 않은 PIN 명령.
   *
   * `OPS_REVIEW_REQUIRED` 를 포함한다 — 지금 영구 동결돼 있는 그 backlog 가 바로 P30 이 풀려는
   * 모집단이고, 자동 판정이 무엇을 골랐을지에 대한 근거가 여기서 나온다.
   */
  static readonly OBSERVED_STATUSES: PinIssueCommandStatus[] = [
    PinIssueCommandStatus.STARTED,
    PinIssueCommandStatus.RETRY_PENDING,
    PinIssueCommandStatus.RECONCILING,
    PinIssueCommandStatus.RETRYING,
    PinIssueCommandStatus.UNKNOWN_DEFERRED,
    PinIssueCommandStatus.OPS_REVIEW_REQUIRED,
  ];

  constructor(
    @InjectRepository(PinIssueCommandEntity)
    private readonly pinIssueCommandRepository: Repository<PinIssueCommandEntity>,
    private readonly partnerCompanyExternService: PartnerCompanyExternService,
    private readonly pinObservationService: SsgPinObservationService,
    private readonly autoResolveConfig: SsgAutoResolveConfig,
  ) {}

  /**
   * 한 주기 관측. 아무것도 mutate 하지 않는다.
   * @returns 조회한 후보 수 / 실제 기록된 run 수(버킷 중복은 recorded 에 세지 않는다).
   */
  async observeOnce(): Promise<{ candidates: number; recorded: number; failed: number }> {
    const mode = this.autoResolveConfig.mode;
    if (!this.observesAnyCommand(mode)) return { candidates: 0, recorded: 0, failed: 0 };

    const candidates = await this.findObservationCandidates(mode, new Date());
    let recorded = 0;
    let failed = 0;

    for (const command of candidates) {
      try {
        // 순수 판정. claim·recordResolution·applyConfirmedCandidate 어느 것도 부르지 않는다.
        const classification = await this.partnerCompanyExternService.classifyDeferredSsgIssue(command.orderDeliveryId);

        // NOT_ATTEMPTED(P1 자동화 1순위)와 tombstone-only UNKNOWN 도 반드시 기록한다.
        // 후보 0건이라 candidate 행이 없을 뿐, "판정이 없었다" 와는 다른 사실이다.
        const written = await this.pinObservationService.record({
          pinIssueCommandId: command.id,
          orderDeliveryId: command.orderDeliveryId,
          mode,
          aggregateResolution: classification.resolution,
          commandSnapshot: {
            status: command.status,
            externalIssueCount: command.externalIssueCount,
            stateEnteredAt: command.stateEnteredAt ?? null,
            leaseExpiresAt: command.leaseExpiresAt ?? null,
          },
          candidates: classification.verdicts.map((verdict) => ({
            ssgIssueLogId: verdict.candidate.id,
            tryYn: verdict.tryYn,
            resultCd: verdict.resultCd,
            resolution: verdict.resolution,
          })),
        });
        if (written) recorded++;
      } catch (error) {
        // 관측은 운영을 막지 않는다. 한 건 실패가 나머지 표본을 날리지 않도록 흡수한다.
        failed++;
        this.logger.warn(
          `[P30] 관측 실패 — skip. commandId=${command.id}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    if (candidates.length) {
      this.logger.log(
        `[P30] 관측 완료 — mode=${mode}, candidates=${candidates.length}, recorded=${recorded}, failed=${failed}`,
      );
    }
    return { candidates: candidates.length, recorded, failed };
  }

  /**
   * 이 모드가 관측할 수 있는 command 가 아예 없는가. `off` + 미enrollment 조합만이 관측 금지이므로,
   * 그 조합은 아래 SQL 의 `autoresolve_version = 1` 선필터로 걸러난다.
   */
  private observesAnyCommand(mode: SsgAutoResolveMode): boolean {
    return resolveSsgAutoResolveCapability(mode, true).recordObservation;
  }

  /**
   * 관측 대상 명령. **적격성 조건을 전부 LIMIT 앞에서** 걸러야 한다.
   *
   * 앱에서 skip 하는 구조면 정렬을 고쳌도 기아가 그대로 재발한다 — skip 된 행은 관측 기록이
   * 안 생기므로 `MAX(completed_at)=NULL` 로 다음 주기에도 다시 최우선 50건을 차지하고, 그 뒤의
   * 적격 command 는 영원히 차례가 오지 않는다.
   *
   * 정렬은 **마지막 관측이 가장 오래된 순**. MySQL 은 NULLS FIRST 가 없으므로
   * `MAX(completed_at) IS NOT NULL` 로 미관측을 앞에 둔다. lease·next_attempt due 조건은 없다
   * — 관측은 선점하지 않는다.
   *
   * 제외 조건(정상 in-flight 발급 — 로그 0행이 '미시도'가 아니라 '아직'인 것들):
   *  - `STARTED` + count=0 : 최초 권한 소비 직전
   *  - live lease 보유      : 다른 worker 가 실행 중
   *  - 체류 5분 미만      : SSG 등록·로그 반영 지연 창
   *
   * `partnerType=SSG` 로 좀힌다. 다른 협력사 명령은 ssg_issue_log 가 없어 전부 NOT_ATTEMPTED 로 잡혀
   * §5-4 판정 근거를 오염시킨다.
   */
  private async findObservationCandidates(mode: SsgAutoResolveMode, now: Date): Promise<PinIssueCommandEntity[]> {
    const query = this.pinIssueCommandRepository
      .createQueryBuilder('c')
      .leftJoin('ssg_pin_observation_run', 'r', 'r.pin_issue_command_id = c.id AND r.completed_at IS NOT NULL')
      .where('c.partner_type = :partnerType', { partnerType: IPartnerCompanyType.SSG })
      .andWhere('c.status IN (:...statuses)', { statuses: SsgPinObservationSweepService.OBSERVED_STATUSES })
      .andWhere('NOT (c.status = :started AND c.external_issue_count = 0)', {
        started: PinIssueCommandStatus.STARTED,
      })
      .andWhere('(c.lease_expires_at IS NULL OR c.lease_expires_at <= :now)', { now })
      .andWhere('(c.state_entered_at IS NULL OR c.state_entered_at <= :dwellCutoff)', {
        dwellCutoff: new Date(now.getTime() - SsgPinObservationSweepService.MIN_DWELL_MS),
      });

    if (mode === SsgAutoResolveMode.OFF) {
      // off 에선 drain 대상(enrollment 된 command)만 관측한다. 이걸 앱에서 걸러내면 미enrollment 앞줄이
      // 상한을 다 먹어 drain command 가 관측되지 않는다.
      query.andWhere('c.autoresolve_version = 1');
    }

    return query
      .groupBy('c.id')
      .orderBy('MAX(r.completed_at) IS NOT NULL', 'ASC')
      .addOrderBy('MAX(r.completed_at)', 'ASC')
      .addOrderBy('c.id', 'ASC')
      .limit(SsgPinObservationSweepService.OBSERVE_LIMIT)
      .getMany();
  }
}
