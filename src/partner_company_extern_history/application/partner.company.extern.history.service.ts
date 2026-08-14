import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import {
  GetPartnerCompanyExternHistoryFilterReqDto,
  GetPartnerCompanyExternHistoryListReqDto,
} from '../api/partner.company.extern.history.req.dto';
import {
  GetPartnerCompanyExternHistoryListResDto,
  GetResendTargetIdsResDto,
  PartnerCompanyExternHistoryViewDto,
  GetPartnerCompanyTypesResDto,
  ResendResultDto,
  FailType,
} from '../api/partner.company.extern.history.res.dto';
import { format } from 'date-fns';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { IProductType } from '../../product/interface/product.type';
import { DeliveryBatchService } from '../../delivery/application/delivery.batch.service';
import { CreateResendTransactionId } from '../../order/domain/create.transaction.id';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { SsgInsertStateService } from '../../delivery/application/ssg-insert-state.service';
import { DeliveryCutoverGuardService } from '../../delivery/application/delivery-cutover-guard.service';
import {
  LegacyDeliveryEntryPoint,
  NOT_CUTOVER_ORDER_DELIVERY,
} from '../../delivery/interface/legacy.delivery.entry.point';
import { SsgInsertState } from '../../delivery/interface/ssg.insert.state';
import { SsgOrphanResolveOutcome } from '../../partner_company_extern/interface/ssg.orphan.resolve';
import { SsgPinVerdict } from '../../partner_company_extern/interface/ssg.issue';
import {
  MUTATION_CLAIM_STALE_MS,
  UNSENDABLE_COUPON_STATUSES,
} from '../../delivery/interface/order.delivery.mutation.claim';
import { DeliveryWorkflowEntity } from '../../entity/delivery.workflow.entity';
import { DeliveryWorkflowStatus } from '../../delivery/interface/delivery.workflow.status';
import {
  DeliveryFailureSotReader,
  DeliveryFailureSotView,
  FAILURE_LIST_WORKFLOW_STATUSES,
  RESEND_ATTEMPT_TYPES,
} from './delivery.failure.sot.reader';

// 재발송 가능한 실패 상태 목록
const RESENDABLE_FAIL_STATUSES = [IOrderDeliveryStatus.FAIL, IOrderDeliveryStatus.FAIL_SMS];

// ── 화면 SoT 고정(§8) ───────────────────────────────────────────────────────
// 컷오버 전환 건(`cutover_migrated_at IS NOT NULL`)은 delivery_workflow 가 유일 SoT 다.
// 미전환 건만 legacy `order_delivery.status` 를 SoT 로 읽는다. 목록 필터·버튼 활성화는
// 어떤 경우에도 전환 건의 legacy 미러를 근거로 하지 않는다.
const MIGRATED_PREDICATE = '`wf`.`cutover_migrated_at` IS NOT NULL';
const NOT_MIGRATED_PREDICATE = '`wf`.`cutover_migrated_at` IS NULL';

// 전환 건의 "재발송완료" 판정 — 자동(AUTO_504)·수동(MANUAL_RESEND) 시도가 존재하는 체인.
const HAS_RESEND_ATTEMPT_PREDICATE =
  'EXISTS (SELECT 1 FROM message_attempt ma WHERE ma.order_delivery_id = `orderDelivery`.`id` ' +
  `AND ma.attempt_type IN (${RESEND_ATTEMPT_TYPES.map((t) => `'${t}'`).join(', ')}))`;

/**
 * 발송실패목록의 **기준 일시**. 전환 건은 workflow 상태 진입 시각, 미전환 건은 legacy 시각을 쓴다.
 *
 * ⚠️ **미전환 건에서만** 필터(startAt/endAt) · 정렬(sortDate) · 화면 표시(parseOrderDeliveryView)
 * 세 곳이 같은 값을 쓴다. 어긋나면 "2월로 검색했는데 8월 건이 나온다"가 된다. TS 표시 로직
 * (parseOrderDeliveryView 의 `legacyDisplayDate`)이 이 순서를 그대로 복제하므로 한쪽만 고치지 말 것.
 *
 * ⚠️ **전환 건은 두 축이 다르다.** 필터·정렬은 여기 ① `wf.state_entered_at` 을 쓰는데, 화면은
 *   `sot.lastResolvedAt`(parseOrderDeliveryView 의 sotDisplayDate)을 쓴다. `state_entered_at` 은
 *   `RESOLVED_MANUALLY_*` 로 넘어갈 때 갱신되므로, 운영자가 나중에 수동 종결하면 화면 날짜로
 *   검색해도 안 나온다 — 이 주석이 든 예시와 **같은 형태**다. 이 PR 은 그 축을 통일하지 않는다.
 *
 *   그리고 아래 ④⑤ 는 **전환 건에 닿지 않는다.** `sot.lastResolvedAt` 이 `stateEnteredAt`
 *   (NOT NULL DEFAULT CURRENT_TIMESTAMP(6))으로 폴백해 절대 null 이 되지 않기 때문이다.
 *   즉 이 상수를 고쳐도 전환 건 화면은 안 바뀐다.
 *
 *   ⭐ 2026-08-14 운영 실측 — 전환 0건 / shadow 19,137건 중 이 목록 대상 60건:
 *     · FAILED_FINAL 45건        → 두 축이 **전부 일치**. 실제로 실패한 건은 문제가 없다.
 *     · OPS_REVIEW_REQUIRED 15건 → 재료 있는 10건 중 9건 날짜 불일치. 단 이 상태는 **아직 실패한
 *       것이 아니라** SLA 초과 승격이라, "실패 시각"이라는 값 자체가 없다(5건은 재료도 없다).
 *     즉 축 불일치는 버그라기보다 **"아직 실패 안 한 건의 발생일시를 무엇으로 볼 것인가"** 라는
 *     미결 업무 결정이다. 운영 확인 전까지 코드로 통일하지 말 것.
 *
 *   ⚠️ **전환을 시작하기 전에** 다시 확인할 것 — 지금 0 인 값들이라 시간이 지나면 거짓이 된다.
 *     ① RESOLVED_MANUALLY_* 건수(현재 0). 생기면 **실제 실패 건인데** 날짜가 종결일로 밀린다.
 *     ② 위 60건 대조를 재실행해 FAILED_FINAL 불일치가 0 을 유지하는지.
 *     ③ OPS_REVIEW_REQUIRED 를 이 목록에 계속 둘지(운영 확인).
 *
 * 칸 순서와 근거
 *  ① wf.state_entered_at  컷오버 전환 건만. CASE 에 ELSE 가 없어 미전환 건은 NULL 로 떨어져 다음
 *                         칸으로 넘어간다(전환 여부 분기를 COALESCE 로 표현한 것).
 *  ② actual_send_at       실제 발송 시각.
 *  ③ failed_at            실패 시각. 2026-02-25(1d04c425) 신설이고 **백필하지 않았다.** 그 이전
 *                         실패 건은 영구히 NULL 이라 아래 칸으로 떨어진다.
 *  ④ send_request_at      발송 요청·예약 시각. created_at 이 아니라 이것을 쓰는 이유 — 예약발송에서는
 *                         주문 접수일과 발송 시도일이 갈리는데, 이 목록이 답해야 하는 것은 "언제
 *                         실패했나"이지 "언제 주문했나"가 아니다. NULLIF 로 감싼 것은 MySQL 의
 *                         '0000-00-00' 이 NULL 이 아니어서 COALESCE 가 그대로 채택해 버리기 때문이다.
 *  ⑤ updated_at           최후 폴백. **의도적으로 남긴다.**
 *
 * ⚠️ ⑤ 를 남긴 이유와, 남기면서도 기준으로 삼지 않는 이유
 *
 *    updated_at 은 행을 건드리기만 하면 바뀌므로 **사건 시각이 아니다.** 실제로 ⑤ 가 사실상의
 *    기준이던 시절, 180일 뒤 PII 파기 배치가 옛 실패 건의 updated_at 을 갱신하면서 "6개월 전 건이
 *    오늘 실패로 목록 맨 위에 뜨는" 사고가 있었다(order_delivery 98182 — 2026-02-11 건이 2026-08-10
 *    00:00:03 으로 표시). 돈·CS 화면에서 운영자가 그것을 당일 장애로 오인한다.
 *
 *    그럼에도 지우지 않는 것은 ④ 가 NOT NULL 이라 **정상 경로에서는 도달할 수 없기 때문**이다.
 *    즉 ⑤ 도달은 그 자체로 "④ 를 못 채운 다른 버그가 있다"는 신호다. 날짜를 비워 정렬·필터를
 *    깨뜨리는 대신, 값은 채우되 도달을 점검할 수 있게 남긴다.
 *
 *    ⚠️ 도달은 화면상 보이지 않는다(④ 에서 왔는지 ⑤ 에서 왔는지 응답만으로는 구분 불가). 이 사고의
 *    원인이 정확히 그 침묵이었으므로 점검 수단을 여기 같이 둔다. 결과가 0 이 아니면 **폴백을 더
 *    늘리지 말고** ④ 를 못 채운 경로를 찾을 것.
 *
 *    (전환 건을 빼는 이유 — ① state_entered_at 이 NOT NULL 이라 ④⑤ 에 도달할 수 없고, 표시도
 *     lastResolvedAt 이라 legacyDisplayDate 에 닿지 않는다. 즉 이 쿼리의 관심 밖이다.)
 *
 *      SELECT COUNT(*) FROM order_delivery od
 *      LEFT JOIN delivery_workflow wf ON wf.order_delivery_id = od.id
 *      WHERE od.deleted_at IS NULL AND wf.cutover_migrated_at IS NULL
 *        AND od.actual_send_at IS NULL AND od.failed_at IS NULL
 *        AND (od.send_request_at IS NULL OR od.send_request_at = '0000-00-00 00:00:00');
 *      -- 2026-08-10 운영 실측: 0
 *
 *    ⚠️ 이 쿼리는 정확히 '0000-00-00 00:00:00' 만 센다. `2026-00-00` 같은 **부분 제로날짜**는
 *      세지 못하고, sql_mode 에 따라 리터럴 비교 자체가 무력화될 수도 있다. 그래서 표시 쪽 방어는
 *      이 실측이 아니라 `validDate`(아래) 로 둔다 — 측정값으로 방어를 생략하지 않는다.
 *      모드에 안 걸리는 대안: WHERE od.send_request_at < '1000-01-01'
 */
/**
 * SQL 쪽 무효 날짜 판정. TS 의 `isValidDate` 와 **같은 기준**이어야 한다.
 *
 * ⚠️ 왜 `NULLIF(col, '0000-00-00 00:00:00')` 이 아닌가 — 그것은 정확히 그 리터럴 하나만 걷어낸다.
 *   `2026-00-00` 같은 **부분 제로날짜**는 통과하는데, JS 에서는 그것도 Invalid Date 다. 그러면
 *   필터·정렬은 그 값을 쓰고 화면은 다음 칸을 써서 **화면 날짜로 검색해도 안 나오는** 상태가 된다.
 *   이 파일이 맨 위에서 금지한 바로 그 상태다.
 *
 * ⚠️ 범위 비교(`col > '1000-01-01'`)로도 부족하다 — `2026-00-00` 은 연도가 2026 이라 그 비교를
 *   통과한다. 그래서 연·월·일을 **각각** 본다. 셋 다 0 보다 커야 실재하는 날짜다.
 *
 * ⚠️ sql_mode 에 의존하지 않는다. 리터럴 비교가 아니라 값에서 뽑은 성분을 보기 때문이다.
 *
 * 성능: 컬럼에 함수를 씌우므로 인덱스를 못 탄다. 다만 이 식은 **PR 이전부터** COALESCE·CASE 라
 *   이미 인덱스를 못 탔다 — 회귀가 아니다.
 *
 * ⚠️ 미검증 — 실 MySQL 에 대고 돌려보지 못했다(운영 RDS 는 로컬 직결 불가). MySQL 의 YEAR/MONTH/DAY
 *   가 제로·부분제로에서 0 을 준다는 문서상 동작에 기대고 있다. 배포 전 개발 DB 에서 한 번 확인할 것:
 *     SELECT YEAR('2026-00-00'), MONTH('2026-00-00'), DAY('2026-00-00');  -- 2026, 0, 0 이어야 한다
 */
const validDateSql = (column: string): string =>
  `CASE WHEN YEAR(${column}) > 0 AND MONTH(${column}) > 0 AND DAY(${column}) > 0 THEN ${column} END`;

const LIST_DATE_EXPR =
  'COALESCE(' +
  // (1) 컷오버 전환 건만. ELSE 가 없어 미전환 건은 NULL 로 떨어져 다음 칸으로 간다.
  '(CASE WHEN `wf`.`cutover_migrated_at` IS NOT NULL THEN ' +
  validDateSql('`wf`.`state_entered_at`') +
  ' END), ' +
  // (2) 실제 발송 → (3) 실패 → (4) 발송 요청 → (5) 안전망. TS 의 legacyDisplayDate 와 같은 순서다.
  validDateSql('`orderDelivery`.`actual_send_at`') +
  ', ' +
  validDateSql('`orderDelivery`.`failed_at`') +
  ', ' +
  validDateSql('`orderDelivery`.`send_request_at`') +
  ', ' +
  validDateSql('`orderDelivery`.`updated_at`') +
  ')';

/**
 * `LIST_DATE_EXPR` 의 `NULLIF` 와 **짝**이다. SQL 이 걷어내는 값을 TS 도 같은 자리에서 걷어낸다.
 *
 * ⚠️ 왜 필요한가 — MySQL 의 제로날짜(`0000-00-00`)는 `NULL` 이 아니라 **값**이라 `NOT NULL` 컬럼에도
 *   들어갈 수 있고, mysql2 는 그것을 `new Date(NaN)` 으로 돌려준다. 그 값은 null 이 아니므로
 *   `??` 를 그대로 통과하고, 뒤이어 `format()`(date-fns v3)이 `RangeError` 를 던진다.
 *   호출부가 `.map()` 안이라 **그 행 하나가 아니라 페이지 전체가 500** 이 된다.
 *   종전 마지막 칸 `updated_at` 은 `datetime(6) NOT NULL` 이라 이 경로가 없었다 — ④ 를 넣으면서
 *   처음 열렸다(리뷰 HIGH-1).
 *
 * ⚠️ SQL 쪽 `NULLIF` 만으로는 부족하다. 그것은 정확히 `'0000-00-00 00:00:00'` 하나만 걷어내므로
 *   `2026-00-00` 같은 **부분 제로날짜**는 통과시킨다(그것도 JS 에서 Invalid Date 다).
 *   그래서 최종 방어는 리터럴 비교가 아니라 **값이 유효한가**를 묻는 여기에 둔다.
 */
const isValidDate = (d: Date | null | undefined): d is Date => {
  // 형제 코드(delivery.batch.service.ts 의 formatAuditTimestamp)와 같은 형태다 — optional call 로
  // Date 아닌 값이 와도 TypeError 대신 '무효' 로 떨어뜨린다.
  const time = d?.getTime?.();
  return typeof time === 'number' && !Number.isNaN(time);
};

/**
 * 목록 렌더 **한 번(요청 하나)** 동안 무효 날짜를 몇 번 만났는지 담는 통.
 *
 * ⚠️ 서비스는 싱글턴이라 인스턴스 필드로 두면 동시에 들어온 요청끼리 숫자가 섞인다.
 *   그래서 호출마다 새로 만들어 인자로 넘긴다.
 */
type ListDateGuardSink = { invalidCount: number };

// claim self-heal 임계(ms). 크래시로 finally 못 탄 stale claim 만 재claim 허용.
// claim 게이트(재claim 조건)와 거부 사유 판정(처리중 여부)이 동일 경계를 쓰도록 공유한다.
// 값은 "단일 oneSend 최악 소요시간"보다 커야 한다(아니면 진짜 처리 중인데 재claim → 중복 발송).
// 외부 API 타임아웃 30s/호출 · retry 1회 · SSG check 재시도 기준, 5분이면 충분한 여유가 있다.
const RESEND_CLAIM_STALE_MS = 5 * 60 * 1000;

// 협력사 타입 한글 매핑
const PartnerCompanyTypeKo: Record<IPartnerCompanyType, string> = {
  [IPartnerCompanyType.GIFT_SHOW]: 'KT알파 (기프티쇼)',
  [IPartnerCompanyType.GS_M_BIZ]: 'GS 엠비즈',
  [IPartnerCompanyType.GIFTIEL]: '대홍기획 (기프티엘)',
  [IPartnerCompanyType.CULTURELAND]: '컬쳐랜드',
  [IPartnerCompanyType.GALAXIA]: '갤럭시아',
  [IPartnerCompanyType.SSG]: '신세계',
  [IPartnerCompanyType.DAOU]: '다우기술',
  [IPartnerCompanyType.PIN_INVENTORY]: '해외쿠폰 재고',
};

@Injectable()
export class PartnerCompanyExternHistoryService {
  private logger = new Logger('PARTNER_COMPANY_EXTERN_HISTORY');

  constructor(
    @InjectRepository(PartnerCompanyExternHistoryEntity)
    private historyRepository: Repository<PartnerCompanyExternHistoryEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    private cryptoCipher: CryptoCipher,
    @Inject(forwardRef(() => DeliveryBatchService))
    private deliveryBatchService: DeliveryBatchService,
    private readonly partnerCompanyExternService: PartnerCompanyExternService,
    private readonly ssgInsertStateService: SsgInsertStateService,
    private readonly cutoverGuard: DeliveryCutoverGuardService,
    private readonly sotReader: DeliveryFailureSotReader,
  ) {}

  /**
   * 공통 필터 쿼리빌더 생성.
   *
   * 컷오버 전환 건과 미전환 건을 **각자의 SoT 로만** 필터한다(§8).
   * - 전환 건: `delivery_workflow.workflow_status` (실패·운영확인 종결) 또는 재발송을 거친 전달 완료
   * - 미전환 건: 기존 `order_delivery.status`/`resendAt`
   */
  private createFilteredQueryBuilder(filter: GetPartnerCompanyExternHistoryFilterReqDto) {
    const { startAt, endAt, type, searchKeyword } = filter;

    const queryBuilder = this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .leftJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .leftJoinAndSelect('orderProductMapping.order', 'order')
      .leftJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoin(DeliveryWorkflowEntity, 'wf', 'wf.orderDeliveryId = orderDelivery.id')
      .withDeleted()
      .where('orderDelivery.deletedAt IS NULL')
      .andWhere(
        `((${MIGRATED_PREDICATE} AND (wf.workflowStatus IN (:...wfFailStatuses)` +
          ` OR (wf.workflowStatus = :wfCompleted AND ${HAS_RESEND_ATTEMPT_PREDICATE})))` +
          ` OR (${NOT_MIGRATED_PREDICATE}` +
          ' AND (orderDelivery.status IN (:...statuses) OR orderDelivery.resendAt IS NOT NULL)))',
        {
          wfFailStatuses: FAILURE_LIST_WORKFLOW_STATUSES,
          wfCompleted: DeliveryWorkflowStatus.COMPLETED,
          statuses: RESENDABLE_FAIL_STATUSES,
        },
      );

    if (startAt) {
      queryBuilder.andWhere(`${LIST_DATE_EXPR} >= :startAt`, { startAt: `${startAt} 00:00:00` });
    }
    if (endAt) {
      queryBuilder.andWhere(`${LIST_DATE_EXPR} <= :endAt`, { endAt: `${endAt} 23:59:59` });
    }

    if (type) {
      queryBuilder.andWhere('partnerCompany.type = :type', { type });
    }

    if (searchKeyword) {
      queryBuilder.andWhere('(order.code LIKE :searchKeyword OR order.eventName LIKE :searchKeyword)', {
        searchKeyword: `%${searchKeyword}%`,
      });
    }

    return queryBuilder;
  }

  /**
   * 발송 실패 내역 목록 조회.
   *
   * 전환 건은 `delivery_workflow`(+하위 시도), 미전환 건은 legacy `order_delivery.status` 를
   * 각각 SoT 로 읽어 렌더한다. 전환 건의 legacy 미러와 workflow 판정이 어긋나면 workflow 를
   * 채택하고 불일치 건수를 `mirrorMismatchCount` 로 노출한다(§10 3단계 PASS 지표).
   */
  async getHistoryList(
    dto: GetPartnerCompanyExternHistoryListReqDto,
  ): Promise<GetPartnerCompanyExternHistoryListResDto> {
    const { page, take } = dto;

    const queryBuilder = this.createFilteredQueryBuilder(dto).addSelect(LIST_DATE_EXPR, 'sortDate');

    // 발송상태 필터 — 전환 건은 workflow, 미전환 건은 legacy 기준으로 각각 판정한다.
    if (dto.sendStatus === 'FAIL') {
      queryBuilder.andWhere(
        `((${MIGRATED_PREDICATE} AND wf.workflowStatus IN (:...failWfStatuses))` +
          ` OR (${NOT_MIGRATED_PREDICATE} AND orderDelivery.status IN (:...failStatuses)` +
          ' AND orderDelivery.resendAt IS NULL))',
        { failWfStatuses: FAILURE_LIST_WORKFLOW_STATUSES, failStatuses: RESENDABLE_FAIL_STATUSES },
      );
    } else if (dto.sendStatus === 'RESEND') {
      queryBuilder.andWhere(
        `((${MIGRATED_PREDICATE} AND wf.workflowStatus = :resendWfCompleted AND ${HAS_RESEND_ATTEMPT_PREDICATE})` +
          ` OR (${NOT_MIGRATED_PREDICATE} AND orderDelivery.resendAt IS NOT NULL))`,
        { resendWfCompleted: DeliveryWorkflowStatus.COMPLETED },
      );
    }

    // 페이징 및 정렬
    //
    // ⚠️ id 보조키는 장식이 아니다. sortDate 는 초 정밀도이고, 한 상품의 모든 발송건이 **같은**
    //   send_request_at 을 갖는다(order.service.ts 가 productSendAt 을 그 상품 전 행에 넣고 한 번에
    //   insert 한다). 동률 행의 LIMIT/OFFSET 순서는 MySQL 이 보장하지 않으므로, 보조키가 없으면
    //   같은 행이 두 페이지에 나오거나(중복) 어느 페이지에도 안 나온다(누락). 재발송 대상을 눈으로
    //   훑는 화면이라 누락은 곧 미발송 방치다. 한 페이지만 보면 멀쩡해 보여 발견이 늦다.
    //   환불목록(refund.service.ts)이 같은 이유로 이미 id 보조키를 쓴다.
    const skip = (page - 1) * take;
    queryBuilder.orderBy('sortDate', 'DESC').addOrderBy('orderDelivery.id', 'DESC').skip(skip).take(take);

    const [orderDeliveries, totalCount] = await queryBuilder.getManyAndCount();

    // 최신 history + 전환 건 SoT 를 배치로 한번에 조회 (N+1 방지)
    const odIds = orderDeliveries.map((od) => od.id);
    const [latestHistoryMap, sotMap] =
      odIds.length > 0
        ? await Promise.all([this.batchFetchLatestHistories(odIds), this.sotReader.loadMigrated(odIds)])
        : [new Map<number, PartnerCompanyExternHistoryEntity>(), new Map<number, DeliveryFailureSotView>()];

    // DTO 변환 (배치로 가져온 history/SoT 전달)
    const sink: ListDateGuardSink = { invalidCount: 0 };
    const list: PartnerCompanyExternHistoryViewDto[] = orderDeliveries.map((od) =>
      this.parseOrderDeliveryView(od, latestHistoryMap.get(od.id) ?? null, sotMap.get(od.id) ?? null, sink),
    );

    return {
      list,
      totalCount,
      totalPage: Math.ceil(totalCount / take),
      currentPage: page,
      mirrorMismatchCount: list.filter((row) => row.mirrorMismatch).length,
      invalidDateCount: sink.invalidCount,
    };
  }

  /**
   * 재발송 대상 orderDelivery ID 목록 조회.
   *
   * 현재 필터 조건에 해당하는 실패 건(재발송 완료 제외)의 ID만 반환한다.
   * **컷오버 전환 건은 제외**한다 — 이 화면의 일괄 재발송은 legacy claim 경로이며,
   * 전환 건은 `MANUAL_RESEND` 슬롯 경로로만 재발송한다(§9 인벤토리 #2, cutover guard 와 동일 경계).
   */
  async getResendTargetIds(dto: GetPartnerCompanyExternHistoryFilterReqDto): Promise<GetResendTargetIdsResDto> {
    const queryBuilder = this.createFilteredQueryBuilder(dto)
      .andWhere(NOT_MIGRATED_PREDICATE)
      .andWhere('orderDelivery.status IN (:...failStatuses)', { failStatuses: RESENDABLE_FAIL_STATUSES })
      .andWhere('orderDelivery.resendAt IS NULL');

    const rows: { orderDelivery_id: number }[] = await queryBuilder.select('orderDelivery.id').getRawMany();

    return {
      orderDeliveryIds: rows.map((row) => row.orderDelivery_id),
      totalCount: rows.length,
    };
  }

  /**
   * 협력사 타입 목록 조회 (드롭다운용)
   */
  async getPartnerCompanyTypes(): Promise<GetPartnerCompanyTypesResDto> {
    const types = Object.entries(PartnerCompanyTypeKo).map(([value, label]) => ({
      value,
      label,
    }));

    return { types };
  }

  /**
   * 여러 orderDeliveryId에 대해 최신 history를 한번에 조회
   */
  private async batchFetchLatestHistories(
    orderDeliveryIds: number[],
  ): Promise<Map<number, PartnerCompanyExternHistoryEntity>> {
    // 해당 ID들의 모든 history를 최신순으로 조회 후 그룹핑
    // 페이지 크기(최대 20건)로 제한되어 데이터 볼륨 안전
    const allHistories = await this.historyRepository
      .createQueryBuilder('h')
      .where('h.orderDeliveryId IN (:...ids)', { ids: orderDeliveryIds })
      .orderBy('h.createdAt', 'DESC')
      .getMany();

    const historyMap = new Map<number, PartnerCompanyExternHistoryEntity>();
    for (const h of allHistories) {
      if (h.orderDeliveryId !== null && !historyMap.has(h.orderDeliveryId)) {
        historyMap.set(h.orderDeliveryId, h);
      }
    }
    return historyMap;
  }

  /**
   * orderDelivery를 View DTO로 변환.
   *
   * 배치로 가져온 latestHistory / 전환 건 SoT 를 인자로 받아 추가 DB 쿼리 없이 변환한다.
   * `sot` 가 있으면(=컷오버 전환 건) 발송상태·실패코드·확정시각·버튼 활성화는 **workflow SoT 만**
   * 근거로 하고, legacy 값은 미러 불일치 지표 계산에만 쓴다(§8 화면 SoT 고정).
   */
  /**
   * 목록 날짜 칸의 **유일한 통로**. 이 파일에서 `format()` 을 직접 부르지 말 것.
   *
   * ⚠️ 왜 통로를 하나로 두나 — 종전에는 칸마다 `x ? format(x) : null` 을 따로 썼는데, 그 truthy
   *   검사는 **Invalid Date 를 통과시킨다**(객체라 truthy 다). 그래서 한 칸을 막아도 옆 칸이 그대로
   *   남았고, 실제로 이 파일에 그런 칸이 5개였다. 통로를 하나로 두면 새 날짜 칸이 생겨도 자동으로 막힌다.
   *
   * ⚠️ 조용히 폴백하지 않는다 — 무효 도달은 **로그 + 응답 카운터** 로 남긴다. 폴백만 하면 화면에
   *   `updated_at`(파기 배치가 오늘로 찍어 둔 값)이 뜨는데, 그건 이 파일이 애초에 없애려던 착시다.
   *   형제 코드(delivery.batch.service.ts 의 formatAuditTimestamp / summarizeRestampRows)도
   *   "값이 없었다" 와 "값이 깨져 있었다" 를 구분해 세는 쪽을 택했다.
   */
  private pickListDate(
    value: Date | null | undefined,
    field: string,
    orderDeliveryId: number,
    sink: ListDateGuardSink,
  ): Date | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (!isValidDate(value)) {
      sink.invalidCount += 1;
      this.logger.warn(
        `[LIST_DATE_INVALID] orderDeliveryId=${orderDeliveryId} field=${field} raw=${String(value)} — ` +
          '무효 datetime(제로날짜 등)이라 다음 칸으로 폴백한다. 0 이 아니면 그 컬럼을 채운 경로를 찾을 것.',
      );
      return null;
    }
    return value;
  }

  /** 위 통로를 태운 뒤 화면 문자열로. 무효거나 없으면 null. */
  private formatListDate(
    value: Date | null | undefined,
    field: string,
    orderDeliveryId: number,
    sink: ListDateGuardSink,
  ): string | null {
    const picked = this.pickListDate(value, field, orderDeliveryId, sink);
    return picked ? format(picked, DateFormatStr) : null;
  }

  private parseOrderDeliveryView(
    orderDelivery: OrderDeliveryEntity,
    latestHistory: PartnerCompanyExternHistoryEntity | null,
    sot: DeliveryFailureSotView | null,
    sink: ListDateGuardSink,
  ): PartnerCompanyExternHistoryViewDto {
    // 협력사 타입
    const partnerCompanyType = orderDelivery.orderProductMapping?.product?.partnerCompany?.type || null;

    // 핀 발급 여부 (barCode 유무로 판단)
    const pinIssued = !!orderDelivery.barCode;

    // 발송상태 결정
    let failType: FailType | 'RESEND' = pinIssued ? FailType.SEND_FAIL : FailType.PIN_ISSUE_FAIL;
    let failTypeKo = pinIssued ? '발송실패' : '핀발급실패';

    // 재발송 완료 건
    if (orderDelivery.resendAt) {
      failType = 'RESEND';
      failTypeKo = '재발송완료';
    }

    // 수신처 마스킹 처리
    const decryptedDeliveryTarget = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget);
    const deliveryTarget = decryptedDeliveryTarget ? this.maskDeliveryTarget(decryptedDeliveryTarget) : null;

    // 주문 정보
    const orderCode = orderDelivery.orderProductMapping?.order?.code || null;
    const eventName = orderDelivery.orderProductMapping?.order?.eventName || null;

    // 가장 최근 history에서 에러 정보 가져오기
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    const transactionId: string | null = orderDelivery.transactionId || null;
    let context: string | null = null;

    if (latestHistory) {
      context = latestHistory.context;
      try {
        const parsedContext = JSON.parse(latestHistory.context);
        errorCode =
          parsedContext.errorCode || parsedContext.resultCode || parsedContext.code || parsedContext.resCode || null;
        errorMessage =
          parsedContext.errorMessage ||
          parsedContext.resultMessage ||
          parsedContext.message ||
          parsedContext.resMsg ||
          parsedContext.msg ||
          null;
      } catch {
        // JSON 파싱 실패 시 무시
      }
    }

    // SSG 실패유형 보정: SSG는 barCode를 로컬 생성하므로 barCode 유무로 판단 불가
    // SSG API(SsgCoupon.do) 호출 실패 = PIN SSG DB 등록 실패 → 핀발급실패로 표시
    // 단, 재발송 완료 건은 보정하지 않음
    if (
      !orderDelivery.resendAt &&
      partnerCompanyType === IPartnerCompanyType.SSG &&
      latestHistory &&
      !latestHistory.isSuccess
    ) {
      failType = FailType.PIN_ISSUE_FAIL;
      failTypeKo = '핀발급실패';
    }

    // 핀은 발급됐지만 발송 실패인 경우, history가 없을 수 있음 (발송 실패는 delivery_send_history에 기록)
    if (pinIssued && !errorMessage) {
      errorMessage = '문자/알림톡 발송 실패';
    }

    // ⚠️ LIST_DATE_EXPR(필터·정렬)의 칸 순서를 **그대로 복제**한 것이다. 근거와 ⑤ 를 남긴 이유는
    // 그 상수의 주석에 있다. 한쪽만 고치면 "필터에는 걸리는데 화면 날짜는 다른" 상태가 된다.
    // ⑤(updated_at)만 validDate 를 안 씌운다 — datetime(6) NOT NULL 이라 무효값이 될 수 없고,
    // 여기서 null 로 만들면 날짜 칸이 빈 채로 나가 정렬·검색과 화면이 어긋난다.
    const legacyDisplayDate =
      this.pickListDate(orderDelivery.actualSendAt, 'actual_send_at', orderDelivery.id, sink) ??
      this.pickListDate(orderDelivery.failedAt, 'failed_at', orderDelivery.id, sink) ??
      this.pickListDate(orderDelivery.sendRequestAt, 'send_request_at', orderDelivery.id, sink) ??
      this.pickListDate(orderDelivery.updatedAt, 'updated_at', orderDelivery.id, sink);

    if (!sot) {
      return {
        id: orderDelivery.id,
        createdAt: legacyDisplayDate ? format(legacyDisplayDate, DateFormatStr) : '',
        type: partnerCompanyType,
        typeKo: partnerCompanyType ? PartnerCompanyTypeKo[partnerCompanyType] || partnerCompanyType : null,
        failType,
        failTypeKo,
        errorCode,
        errorMessage,
        transactionId,
        context,
        orderDeliveryId: orderDelivery.id,
        orderCode,
        eventName,
        deliveryTarget,
        pinIssued,
        resendAt: this.formatListDate(orderDelivery.resendAt, 'resend_at', orderDelivery.id, sink),
        sotSource: 'LEGACY',
        workflowStatus: null,
        workflowStatusKo: null,
        opsReviewReason: null,
        channel: null,
        sendReason: null,
        autoResendCount: 0,
        manualResendCount: 0,
        failureCodeDescription: null,
        opsAction: null,
        lastResolvedAt: null,
        resendable: failType !== 'RESEND',
        resendBlockReason: failType === 'RESEND' ? '이미 재발송이 완료된 건입니다.' : null,
        mirrorMismatch: false,
      };
    }

    // ── 전환 건: workflow SoT 렌더 ───────────────────────────────────────────
    const sotResent = sot.resent && sot.workflowStatus === DeliveryWorkflowStatus.COMPLETED;
    const sotFailType: FailType | 'RESEND' = sotResent
      ? 'RESEND'
      : sot.pinIssueFailed
        ? FailType.PIN_ISSUE_FAIL
        : FailType.SEND_FAIL;
    const sotFailTypeKo = sotResent ? '재발송완료' : sot.pinIssueFailed ? '핀발급실패' : '발송실패';
    const sotDisplayDate =
      this.pickListDate(sot.lastResolvedAt, 'sot.lastResolvedAt', orderDelivery.id, sink) ?? legacyDisplayDate;

    // 미러 불일치(§10 3단계 지표): workflow 는 실패로 종결했는데 legacy 미러가 실패가 아니거나,
    // workflow 는 전달 완료인데 legacy 미러가 아직 실패로 남아 있는 경우.
    const legacyIsFail = RESENDABLE_FAIL_STATUSES.includes(orderDelivery.status);
    const workflowIsFail = FAILURE_LIST_WORKFLOW_STATUSES.includes(sot.workflowStatus);
    const mirrorMismatch = workflowIsFail !== legacyIsFail;

    return {
      id: orderDelivery.id,
      createdAt: sotDisplayDate ? format(sotDisplayDate, DateFormatStr) : '',
      type: partnerCompanyType,
      typeKo: partnerCompanyType ? PartnerCompanyTypeKo[partnerCompanyType] || partnerCompanyType : null,
      failType: sotFailType,
      failTypeKo: sotFailTypeKo,
      errorCode: sot.failureCode?.code ?? null,
      errorMessage: sot.failureCode?.description ?? null,
      transactionId,
      context,
      orderDeliveryId: orderDelivery.id,
      orderCode,
      eventName,
      deliveryTarget,
      pinIssued: sot.pinIssued,
      resendAt: this.formatListDate(sot.deliveredAt, 'sot.deliveredAt', orderDelivery.id, sink),
      sotSource: 'WORKFLOW',
      workflowStatus: sot.workflowStatus,
      workflowStatusKo: sot.workflowStatusKo,
      opsReviewReason: sot.opsReviewReason,
      channel: sot.channel,
      sendReason: sot.sendReason,
      autoResendCount: sot.autoResendCount,
      manualResendCount: sot.manualResendCount,
      failureCodeDescription: sot.failureCode?.description ?? null,
      opsAction: sot.failureCode?.opsAction ?? null,
      lastResolvedAt: this.formatListDate(sot.lastResolvedAt, 'sot.lastResolvedAt', orderDelivery.id, sink),
      // 전환 건의 재발송은 이 화면의 legacy claim 경로가 아니라 MANUAL_RESEND 슬롯 경로 소관이다.
      resendable: false,
      resendBlockReason: '컷오버 전환 건은 운영 재발송(MANUAL_RESEND) 슬롯 경로로만 처리합니다.',
      mirrorMismatch,
    };
  }

  /**
   * 수신처 마스킹 처리
   */
  private maskDeliveryTarget(target: string): string {
    if (!target) return '';

    // 이메일인 경우
    if (target.includes('@')) {
      const [local, domain] = target.split('@');
      if (local.length <= 2) {
        return `${local[0]}*@${domain}`;
      }
      return `${local.substring(0, 2)}${'*'.repeat(local.length - 2)}@${domain}`;
    }

    // 전화번호인 경우 (숫자만 있는 경우)
    if (/^\d+$/.test(target)) {
      if (target.length <= 4) return target;
      const start = target.substring(0, 3);
      const end = target.substring(target.length - 4);
      return `${start}****${end}`;
    }

    // 기타
    if (target.length <= 4) return target;
    return `${target.substring(0, 2)}${'*'.repeat(target.length - 4)}${target.substring(target.length - 2)}`;
  }

  /**
   * 발송 실패 건 재발송 (배치 동시성 모델).
   *
   * 기존 SELECT FOR UPDATE + @Transactional 은 order_delivery 행을 잠근 채 oneSend()→issue() 의
   * REQUIRES_NEW(markAttempted FK / markConfirmed order_delivery UPDATE) 를 호출해 self-deadlock 을
   * 유발했다(lock wait timeout). 배치처럼 짧은 원자적 claimedAt 게이트로 동시성을 차단하고,
   * 락 없는 상태로 oneSend() 를 호출한다.
   *
   * - claim: app 생성 claimAt 토큰을 저장. 5분 self-heal(크래시로 finally 못 탄 stale claim 만 재claim).
   * - 모든 해제(성공/실패/예외/게이트 거부)는 owner guard(claimed_at=:claimAt) 조건부.
   * - status 는 claim 중에도 FAIL/FAIL_SMS 유지(oneSend 의 wasFailBefore/환불 분기 보존).
   * - SSG 재진입은 getState 로 분기(ATTEMPTED→orphan resolver, CONFIRMED→PIN 무결성, NONE/FAILED→새 PIN).
   */
  async resendFailedDelivery(orderDeliveryId: number): Promise<ResendResultDto> {
    // 0. 컷오버 전환 건 거부(§9 인벤토리 #2). 전환 건의 수동 재발송은 MANUAL_RESEND/PIN_REISSUE 슬롯
    //    경로로만 실행한다. claimedAt 토큰은 신규 Level A 슬롯을 모르므로 둘을 병행시키지 않는다.
    await this.cutoverGuard.assertLegacyAllowed(orderDeliveryId, LegacyDeliveryEntryPoint.FAILURE_LIST_RESEND);

    // 1. 대상 조회 (락 없음). 동시 재발송은 아래 원자적 claim 으로 차단.
    const target = await this.buildResendQuery(orderDeliveryId).getOne();
    if (!target) {
      return this.classifyResendRejection(orderDeliveryId);
    }

    const product = target.orderProductMapping.product;
    if (!product || (product.type === IProductType.CHOICE && product.deletedAt)) {
      return { success: false, message: '삭제된 초이스 쿠폰은 재발송할 수 없습니다.', orderDeliveryId };
    }

    // 2. barCode 에 한글(=에러 메시지 저장값) → 미발급 취급
    if (target.barCode && /[가-힣]/.test(target.barCode)) {
      this.logger.warn(
        `[resendFailedDelivery] barCode에 잘못된 값 감지, 초기화: "${target.barCode}" (orderDeliveryId: ${orderDeliveryId})`,
      );
      target.barCode = null;
    }
    const pinIssued = !!target.barCode;
    const partnerCompanyType = target.orderProductMapping?.product?.partnerCompany?.type;
    const isSsg = partnerCompanyType === IPartnerCompanyType.SSG;

    this.logger.log(
      `[resendFailedDelivery] orderDeliveryId: ${orderDeliveryId}, pinIssued: ${pinIssued}, partnerCompanyType: ${partnerCompanyType}`,
    );

    // SSG 는 barCode 있어도 SSG DB 미등록일 수 있으므로 oneSend 내부에서 재확인
    const needsPinIssue = !pinIssued || isSsg;

    // 3. 재발급 필요 시 transactionId 갱신(협력사 거래번호 중복 방지). 컬처랜드는 기존 유지.
    let newTransactionId: string | undefined;
    if (needsPinIssue && partnerCompanyType !== IPartnerCompanyType.CULTURELAND) {
      const orderId = target.orderProductMapping?.order?.id;
      if (!orderId) {
        return { success: false, message: '주문 정보를 찾을 수 없습니다.', orderDeliveryId };
      }
      const retryMatch = target.transactionId?.match(/R(\d+)$/);
      const retryCount = retryMatch ? parseInt(retryMatch[1], 10) + 1 : 1;
      newTransactionId = CreateResendTransactionId(orderId, orderDeliveryId, retryCount);
    }

    // 4. 원자적 claim (owner 토큰 = app 생성 claimAt). 5분 self-heal: 크래시로 남은 stale claim 만 재claim.
    //
    // ★ 변형 lease(mutation_claimed_at) 를 **함께** 획득한다 (D3-55 후속, 리뷰 CRITICAL).
    //   이 경로는 oneSend() → 외부 통신(PIN 발급 + 문자 발송) 으로 수 초가 걸린다. 그 사이에
    //   폐기(execDiscard)·외부취소(cancelOrder)·재발행이 같은 행에 진입하면 협력사에서 핀이
    //   죽고 환불까지 나간 뒤 우리가 그 핀을 고객에게 배달한다. CS 재발행·발송배치·외부 API 는
    //   이미 이 lease 를 존중하는데 이 경로만 이탈해 있었다 — 심지어 재발행 실패 시 우리가
    //   운영자에게 안내하는 경로("발송실패내역에서 재발송")가 바로 여기다.
    //   claimedAt 과 **같은 토큰**을 쓴다(해제도 같은 값으로 owner-guard).
    const claimAt = new Date();
    const staleThreshold = new Date(claimAt.getTime() - RESEND_CLAIM_STALE_MS);
    const mutationStale = new Date(claimAt.getTime() - MUTATION_CLAIM_STALE_MS);
    const claimSet = {
      claimedAt: claimAt,
      mutationClaimedAt: claimAt,
      ...(newTransactionId && { transactionId: newTransactionId }),
    };
    const claimResult = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set(claimSet)
      .where('id = :id', { id: orderDeliveryId })
      .andWhere('status IN (:...statuses)', { statuses: RESENDABLE_FAIL_STATUSES })
      .andWhere('(claimedAt IS NULL OR claimedAt < :stale)', { stale: staleThreshold })
      .andWhere('(mutation_claimed_at IS NULL OR mutation_claimed_at < :mutationStale)', { mutationStale })
      // 이미 폐기·환불된 쿠폰은 재발송하지 않는다(죽은 핀 배달 방지).
      .andWhere('(coupon_status IS NULL OR coupon_status NOT IN (:...unsendable))', {
        unsendable: UNSENDABLE_COUPON_STATUSES,
      })
      // 컷오버 드레이닝·전환 건은 legacy claim 을 잡지 못한다. 위 가드는 빠른 거부용이고,
      // 가드 통과 후 지연된 워커까지 막는 근거는 **점유와 같은 문장에 있는** 이 술어다(§9 quiesce).
      .andWhere(NOT_CUTOVER_ORDER_DELIVERY)
      // UpdateQueryBuilder 는 soft-delete 필터를 자동 적용하지 않는다. 재발행 unwind 가
      // softDelete 한 tip 이 status=FAIL 로 남아 있으면 여기서 되살아나 발송된다.
      .andWhere('deleted_at IS NULL')
      .execute();
    if (!claimResult.affected) {
      return this.classifyResendRejection(orderDeliveryId);
    }

    // claim 소유. 모든 종료 경로에서 owner-guarded 해제 보장.
    try {
      let orderDelivery = await this.buildResendQuery(orderDeliveryId).getOne();
      if (!orderDelivery) {
        throw new Error('claim 후 재조회 실패');
      }
      // 한글 barCode 는 메모리에서도 미발급 취급 (oneSend/gate 판정용)
      if (orderDelivery.barCode && /[가-힣]/.test(orderDelivery.barCode)) {
        orderDelivery.barCode = null;
      }

      // 5. SSG 재진입 게이트 (락 없음)
      if (isSsg) {
        const gate = await this.runSsgResendGate(orderDelivery);
        if (!gate.proceed) {
          await this.releaseClaim(orderDeliveryId, claimAt);
          return { success: false, message: gate.message ?? '재발송을 진행할 수 없습니다.', orderDeliveryId };
        }
        if (gate.reloaded) {
          orderDelivery = gate.reloaded;
        }
      }

      // 6. 발송 (락 없는 상태). oneSend 가 PIN 발급/확인 + 이미지 + 실제 발송 처리.
      //    claim 시 획득한 변형 lease 토큰을 넘겨, 발송 중 lease 가 stale 로 넘어가면
      //    oneSend 의 결과 쓰기가 남이 확정한 상태를 덮지 않게 한다(리뷰 HIGH).
      const sendSuccess = await this.deliveryBatchService.oneSend(orderDelivery, true, undefined, claimAt);

      if (sendSuccess) {
        // 부분 update(owner guard) — oneSend 가 중간 저장한 PIN/status/imagePath 를 stale entity 로 덮어쓰지 않음
        await this.orderDeliveryRepository.update(
          { id: orderDeliveryId, claimedAt: claimAt },
          { resendAt: new Date(), claimedAt: null },
        );
      } else {
        await this.releaseClaim(orderDeliveryId, claimAt);
      }

      let message: string;
      if (sendSuccess && needsPinIssue) {
        message = '재발송 성공 (PIN 발급 + 발송)';
      } else if (sendSuccess) {
        message = '재발송 성공 (기존 발급된 핀으로 발송)';
      } else if (needsPinIssue) {
        message = 'PIN 발급 또는 발송에 실패했습니다.';
      } else {
        message = '발송 실패 - 알림톡/SMS/이메일 발송에 실패했습니다.';
      }
      return { success: sendSuccess, message, orderDeliveryId };
    } catch (e) {
      await this.releaseClaim(orderDeliveryId, claimAt);
      const error = e instanceof Error ? e : new Error(String(e));
      this.logger.error(`[resendFailedDelivery] 재발송 실패: ${error.message}`, error.stack);
      return { success: false, message: error.message || '재발송 중 오류가 발생했습니다.', orderDeliveryId };
    } finally {
      // 변형 lease 해제 — 성공/실패/게이트거부/예외 모든 종료 경로. **자기 토큰으로만** 푼다.
      // claimedAt 해제와 한 번의 update 로 합치지 않는 이유: claimedAt 은 살아 있는데 변형 lease 만
      // stale 로 빼앗긴 경우(폐기가 acquireMutationLease 로 가져감), 합치면 남의 활성 lease 를 지운다.
      // 해제 실패는 삼킨다 — 실패했다면 DB 가 죽은 것이라 재시도해도 못 쓰고, 5분 stale 로 self-heal 된다.
      try {
        await this.orderDeliveryRepository.update(
          { id: orderDeliveryId, mutationClaimedAt: claimAt },
          { mutationClaimedAt: null },
        );
      } catch (releaseError) {
        this.logger.error(
          `[resendFailedDelivery] 변형 lease 해제 실패 — 최대 5분간 이 건의 폐기/취소가 거절된다. ` +
            `orderDeliveryId=${orderDeliveryId}, error: ${releaseError}`,
        );
      }
    }
  }

  /** 재발송 대상 조회 쿼리(relation 포함, 재발송 가능 상태 필터). 락 없음. */
  private buildResendQuery(orderDeliveryId: number) {
    return (
      this.orderDeliveryRepository
        .createQueryBuilder('orderDelivery')
        .leftJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
        .leftJoinAndSelect('orderProductMapping.order', 'order')
        .leftJoinAndSelect('order.user', 'user')
        .leftJoinAndSelect('orderProductMapping.product', 'product')
        .leftJoinAndSelect('product.brand', 'brand')
        .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
        // withDeleted 는 삭제된 **상품**(초이스 삭제 판정, 아래 product.deletedAt) 을 보기 위한 것이다.
        // 그 부작용으로 soft-delete 된 order_delivery 까지 딸려 오므로 명시적으로 배제한다.
        // 재발행 unwind 가 softDelete 한 tip 이 status=FAIL 로 남아 있으면 여기서 되살아나 발송된다.
        .withDeleted()
        .where('orderDelivery.id = :id', { id: orderDeliveryId })
        .andWhere('orderDelivery.deletedAt IS NULL')
        .andWhere('orderDelivery.status IN (:...statuses)', { statuses: RESENDABLE_FAIL_STATUSES })
    );
  }

  /** claim 해제 (owner guard). 내가 소유한 claim(claimedAt=:claimAt)만 해제. */
  private async releaseClaim(orderDeliveryId: number, claimAt: Date): Promise<void> {
    await this.orderDeliveryRepository.update({ id: orderDeliveryId, claimedAt: claimAt }, { claimedAt: null });
  }

  /**
   * 비정상 종료로 남은 FAIL/FAIL_SMS 행의 claimedAt 을 해제한다. main.ts 에서 listen() 전 1회 호출.
   * status/resendAt 은 건드리지 않는다.
   */
  async releaseOrphanedResendClaims(): Promise<number> {
    const result = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set({ claimedAt: null })
      .where('status IN (:...statuses)', { statuses: RESENDABLE_FAIL_STATUSES })
      .andWhere('claimedAt IS NOT NULL')
      .execute();
    return result.affected ?? 0;
  }

  /**
   * 재발송 거부 사유를 판정한다. buildResendQuery(상태 필터 포함)는 재사용하지 않고,
   * status 필터 없이 id/status/claimedAt 만 조회해 현재 상태를 정확히 분류한다.
   *
   * 판정 순서 (status 를 claimedAt 보다 먼저 본다):
   *  1. 행 없음        → 대상 없음
   *  2. soft-delete    → 대상 아님 (재발행 unwind 가 지운 tip)
   *  3. status 비대상   → 이미 완료/대상 아님 (성공 마무리 구간: status=COMPLETE 이지만
   *                       claimedAt 해제가 아직 안 된 찰나를 '처리 중'으로 오진하지 않음)
   *  4. 폐기/환불 쿠폰   → 재발송 불가 (죽은 핀)
   *  5. 최근 claimedAt  → 재발송 처리 중 (5분 이내)
   *  6. 최근 변형 lease → 다른 처리(폐기/취소/재발행) 진행 중
   *  7. 그 외          → 상태 변경(새로고침 유도)
   *
   * claim CAS 에 술어를 추가할 때는 여기 판정도 같이 늘려야 한다. 안 그러면 새 술어로 거절된
   * 건이 전부 "상태가 변경되었습니다"(새로고침 유도) 로 뭉뚱그려져 운영자가 원인을 못 찾는다.
   */
  private async classifyResendRejection(orderDeliveryId: number): Promise<ResendResultDto> {
    const row = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .select([
        'orderDelivery.id',
        'orderDelivery.status',
        'orderDelivery.claimedAt',
        'orderDelivery.mutationClaimedAt',
        'orderDelivery.couponStatus',
        'orderDelivery.deletedAt',
      ])
      .withDeleted()
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .getOne();

    if (!row) {
      return { success: false, message: '재발송 대상을 찾을 수 없습니다.', orderDeliveryId };
    }
    if (row.deletedAt) {
      return { success: false, message: '삭제된 발송 건은 재발송할 수 없습니다.', orderDeliveryId };
    }
    if (!RESENDABLE_FAIL_STATUSES.includes(row.status)) {
      return { success: false, message: '이미 완료되었거나 재발송 대상이 아닙니다.', orderDeliveryId };
    }
    if (row.couponStatus && UNSENDABLE_COUPON_STATUSES.includes(row.couponStatus)) {
      return { success: false, message: '폐기·환불된 쿠폰은 재발송할 수 없습니다.', orderDeliveryId };
    }
    const staleThreshold = new Date(Date.now() - RESEND_CLAIM_STALE_MS);
    if (row.claimedAt && row.claimedAt >= staleThreshold) {
      return { success: false, message: '재발송 처리 중입니다. 잠시 후 다시 시도해주세요.', orderDeliveryId };
    }
    const mutationStale = new Date(Date.now() - MUTATION_CLAIM_STALE_MS);
    if (row.mutationClaimedAt && row.mutationClaimedAt >= mutationStale) {
      return {
        success: false,
        message: '해당 발송 건에 다른 처리(폐기/취소/재발행)가 진행 중입니다. 잠시 후 다시 시도해주세요.',
        orderDeliveryId,
      };
    }
    return {
      success: false,
      message: '재발송 상태가 변경되었습니다. 목록을 새로고침 후 다시 시도해주세요.',
      orderDeliveryId,
    };
  }

  /**
   * SSG 재진입 게이트. oneSend() 전에 state 로 분기해 중복 INSERT / ATTEMPTED limbo / CONFIRMED PIN 유실을 처리.
   * @returns proceed=false 면 caller 가 claim 해제 후 실패 반환. reloaded 있으면 그 엔티티로 oneSend.
   */
  private async runSsgResendGate(
    orderDelivery: OrderDeliveryEntity,
  ): Promise<{ proceed: boolean; message?: string; reloaded?: OrderDeliveryEntity }> {
    const id = orderDelivery.id;

    // SSG 진실원천(cust_info/cust_info_result) 우선 판정 — 기존 PIN 이 있을 때.
    // GetSsgTry(제출여부) + GetSsgStatus(결과/유효성)로 9999 등 모호 케이스를 정확히 분기한다.
    if (orderDelivery.barCode && orderDelivery.personalCode) {
      let verdict: SsgPinVerdict;
      try {
        verdict = await this.partnerCompanyExternService.classifySsgResendPin(id, orderDelivery.personalCode);
      } catch (e) {
        // getTry/check 네트워크·파싱 오류 → 등록 여부 불명 → 보류 (새 INSERT/재사용 금지)
        this.logger.error(
          `[resendFailedDelivery] SSG 판정(classifySsgResendPin) 오류 - 발송 보류. orderDeliveryId=${id}: ${e instanceof Error ? e.message : e}`,
        );
        return {
          proceed: false,
          message: 'SSG 등록 여부를 확정할 수 없습니다. 잠시 후 다시 시도하거나 운영 점검이 필요합니다.',
        };
      }

      switch (verdict) {
        case SsgPinVerdict.PROCESSING:
          // cust_info 제출됐으나 result 미반영 = SSG 처리중 → 안내 + 수동 재시도 유도
          return {
            proceed: false,
            message: '신세계 쪽에서 해당 핀번호 처리중입니다. 잠시 후 다시 시도해주세요.',
          };
        case SsgPinVerdict.REGISTERED:
          // 등록 유효 → 기존 PIN 재사용 (issue step1 이 최종 재확인 + markConfirmed)
          return { proceed: true };
        case SsgPinVerdict.NOT_SUBMITTED:
        case SsgPinVerdict.REGISTRATION_FAILED:
          // 미제출 또는 등록실패 → 기존 PIN 폐기 후 새 PIN 재발급 (메모리 null → issue step2 가 재생성/INSERT)
          this.logger.log(
            `[resendFailedDelivery] SSG 기존 PIN 폐기(${verdict}) - 새 PIN 재발급. orderDeliveryId=${id}`,
          );
          orderDelivery.barCode = null;
          orderDelivery.personalCode = null;
          return { proceed: true, reloaded: orderDelivery };
      }
    }

    const state = await this.ssgInsertStateService.getState(id);

    if (state === SsgInsertState.ATTEMPTED) {
      // INSERT 응답 미확정. 새 PIN/INSERT 전에 SSG check 로 실제 등록 여부 확정.
      const outcome = await this.partnerCompanyExternService.resolveSsgOrphan(id);
      switch (outcome) {
        case SsgOrphanResolveOutcome.CONFIRMED:
          // markConfirmed 가 order_delivery PIN 복원 → 메모리 반영 위해 reload 후 기존 PIN 발송
          return { proceed: true, reloaded: (await this.buildResendQuery(id).getOne()) ?? undefined };
        case SsgOrphanResolveOutcome.FAILED:
          // SSG 미등록 확정 → 새 PIN/INSERT 재시도
          return { proceed: true };
        default:
          // NETWORK_UNKNOWN / SKIPPED_NO_CANDIDATES / SKIPPED_NOT_ATTEMPTED(race) → 미확정, 새 INSERT 금지
          this.logger.warn(
            `[resendFailedDelivery] SSG ATTEMPTED resolver outcome=${outcome} - 발송 보류. orderDeliveryId=${id}`,
          );
          return {
            proceed: false,
            message: 'SSG 등록 여부를 확정할 수 없습니다. 잠시 후 다시 시도하거나 운영 점검이 필요합니다.',
          };
      }
    }

    if (state === SsgInsertState.CONFIRMED) {
      // SSG 등록 확정. PIN 정상이면 기존 PIN 발송(issue step1 이 SSG check 로 최종 검증).
      if (orderDelivery.barCode && orderDelivery.personalCode) {
        return { proceed: true };
      }
      // PIN 유실/깨짐 → ssg_issue_log(진실원천)에서 복원. 없으면 발송 보류(운영 점검).
      const restored = await this.ssgInsertStateService.restoreConfirmedPinFromIssueLog(id);
      if (restored) {
        return { proceed: true, reloaded: (await this.buildResendQuery(id).getOne()) ?? undefined };
      }
      this.logger.error(
        `[resendFailedDelivery] CONFIRMED 인데 PIN 유실 + 복원 후보 없음 - 운영 점검 필요. orderDeliveryId=${id}`,
      );
      return { proceed: false, message: 'PIN 정보가 유실되어 재발송할 수 없습니다. 운영 점검이 필요합니다.' };
    }

    // NONE / FAILED → 새 PIN 정상 경로
    return { proceed: true };
  }
}
