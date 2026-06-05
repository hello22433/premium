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
import { SsgInsertState } from '../../delivery/interface/ssg.insert.state';
import { SsgOrphanResolveOutcome } from '../../partner_company_extern/interface/ssg.orphan.resolve';
import { SsgPinVerdict } from '../../partner_company_extern/interface/ssg.issue';

// 재발송 가능한 실패 상태 목록
const RESENDABLE_FAIL_STATUSES = [IOrderDeliveryStatus.FAIL, IOrderDeliveryStatus.FAIL_SMS];

// 협력사 타입 한글 매핑
const PartnerCompanyTypeKo: Record<IPartnerCompanyType, string> = {
  [IPartnerCompanyType.GIFT_SHOW]: 'KT알파 (기프티쇼)',
  [IPartnerCompanyType.GS_M_BIZ]: 'GS 엠비즈',
  [IPartnerCompanyType.GIFTIEL]: '대홍기획 (기프티엘)',
  [IPartnerCompanyType.CULTURELAND]: '컬쳐랜드',
  [IPartnerCompanyType.GALAXIA]: '갤럭시아',
  [IPartnerCompanyType.SSG]: '신세계',
  [IPartnerCompanyType.DAOU]: '다우기술',
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
  ) {}

  /**
   * 공통 필터 쿼리빌더 생성
   */
  private createFilteredQueryBuilder(filter: GetPartnerCompanyExternHistoryFilterReqDto) {
    const { startAt, endAt, type, searchKeyword } = filter;

    const queryBuilder = this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .leftJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .leftJoinAndSelect('orderProductMapping.order', 'order')
      .leftJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .withDeleted()
      .where('orderDelivery.deletedAt IS NULL')
      .andWhere('(orderDelivery.status IN (:...statuses) OR orderDelivery.resendAt IS NOT NULL)', { statuses: RESENDABLE_FAIL_STATUSES });

    const dateColumn = 'COALESCE(orderDelivery.actualSendAt, orderDelivery.failedAt, orderDelivery.updatedAt)';
    if (startAt) {
      queryBuilder.andWhere(`${dateColumn} >= :startAt`, { startAt: `${startAt} 00:00:00` });
    }
    if (endAt) {
      queryBuilder.andWhere(`${dateColumn} <= :endAt`, { endAt: `${endAt} 23:59:59` });
    }

    if (type) {
      queryBuilder.andWhere('partnerCompany.type = :type', { type });
    }

    if (searchKeyword) {
      queryBuilder.andWhere(
        '(order.code LIKE :searchKeyword OR order.eventName LIKE :searchKeyword)',
        { searchKeyword: `%${searchKeyword}%` },
      );
    }

    return queryBuilder;
  }

  /**
   * 발송 실패 내역 목록 조회
   * orderDelivery.status = FAIL 기준으로 조회 (중복 없이 최종 실패 건만)
   */
  async getHistoryList(dto: GetPartnerCompanyExternHistoryListReqDto): Promise<GetPartnerCompanyExternHistoryListResDto> {
    const { page, take } = dto;

    const dateCoalesceExpr = 'COALESCE(`orderDelivery`.`actual_send_at`, `orderDelivery`.`failed_at`, `orderDelivery`.`updated_at`)';
    const queryBuilder = this.createFilteredQueryBuilder(dto)
      .addSelect(dateCoalesceExpr, 'sortDate');

    // 발송상태 필터
    if (dto.sendStatus === 'FAIL') {
      queryBuilder.andWhere('orderDelivery.status IN (:...failStatuses)', { failStatuses: RESENDABLE_FAIL_STATUSES });
      queryBuilder.andWhere('orderDelivery.resendAt IS NULL');
    } else if (dto.sendStatus === 'RESEND') {
      queryBuilder.andWhere('orderDelivery.resendAt IS NOT NULL');
    }

    // 페이징 및 정렬
    const skip = (page - 1) * take;
    queryBuilder.orderBy('sortDate', 'DESC').skip(skip).take(take);

    const [orderDeliveries, totalCount] = await queryBuilder.getManyAndCount();

    // 최신 history를 배치로 한번에 조회 (N+1 방지)
    const odIds = orderDeliveries.map((od) => od.id);
    const latestHistoryMap = odIds.length > 0
      ? await this.batchFetchLatestHistories(odIds)
      : new Map<number, PartnerCompanyExternHistoryEntity>();

    // DTO 변환 (배치로 가져온 history 전달)
    const list: PartnerCompanyExternHistoryViewDto[] = orderDeliveries.map((od) =>
      this.parseOrderDeliveryView(od, latestHistoryMap.get(od.id) ?? null),
    );

    return {
      list,
      totalCount,
      totalPage: Math.ceil(totalCount / take),
      currentPage: page,
    };
  }

  /**
   * 재발송 대상 orderDelivery ID 목록 조회
   * 현재 필터 조건에 해당하는 실패 건(재발송 완료 제외)의 ID만 반환
   */
  async getResendTargetIds(dto: GetPartnerCompanyExternHistoryFilterReqDto): Promise<GetResendTargetIdsResDto> {
    const queryBuilder = this.createFilteredQueryBuilder(dto)
      .andWhere('orderDelivery.status IN (:...failStatuses)', { failStatuses: RESENDABLE_FAIL_STATUSES })
      .andWhere('orderDelivery.resendAt IS NULL');

    const rows: { orderDelivery_id: number }[] = await queryBuilder
      .select('orderDelivery.id')
      .getRawMany();

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
   * orderDelivery를 View DTO로 변환
   * 배치로 가져온 latestHistory를 인자로 받아 추가 DB 쿼리 없이 변환
   */
  private parseOrderDeliveryView(
    orderDelivery: OrderDeliveryEntity,
    latestHistory: PartnerCompanyExternHistoryEntity | null,
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
    let transactionId: string | null = orderDelivery.transactionId || null;
    let context: string | null = null;

    if (latestHistory) {
      context = latestHistory.context;
      try {
        const parsedContext = JSON.parse(latestHistory.context);
        errorCode = parsedContext.errorCode || parsedContext.resultCode || parsedContext.code || parsedContext.resCode || null;
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
    if (!orderDelivery.resendAt && partnerCompanyType === IPartnerCompanyType.SSG && latestHistory && !latestHistory.isSuccess) {
      failType = FailType.PIN_ISSUE_FAIL;
      failTypeKo = '핀발급실패';
    }

    // 핀은 발급됐지만 발송 실패인 경우, history가 없을 수 있음 (발송 실패는 delivery_send_history에 기록)
    if (pinIssued && !errorMessage) {
      errorMessage = '문자/알림톡 발송 실패';
    }

    const displayDate = orderDelivery.actualSendAt ?? orderDelivery.failedAt ?? orderDelivery.updatedAt;

    return {
      id: orderDelivery.id,
      createdAt: displayDate ? format(displayDate, DateFormatStr) : '',
      type: partnerCompanyType,
      typeKo: partnerCompanyType ? (PartnerCompanyTypeKo[partnerCompanyType] || partnerCompanyType) : null,
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
      resendAt: orderDelivery.resendAt ? format(orderDelivery.resendAt, DateFormatStr) : null,
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
   * - claim: app 생성 claimAt 토큰을 저장. 30분 self-heal(크래시로 finally 못 탄 stale claim 만 재claim).
   * - 모든 해제(성공/실패/예외/게이트 거부)는 owner guard(claimed_at=:claimAt) 조건부.
   * - status 는 claim 중에도 FAIL/FAIL_SMS 유지(oneSend 의 wasFailBefore/환불 분기 보존).
   * - SSG 재진입은 getState 로 분기(ATTEMPTED→orphan resolver, CONFIRMED→PIN 무결성, NONE/FAILED→새 PIN).
   */
  async resendFailedDelivery(orderDeliveryId: number): Promise<ResendResultDto> {
    // 1. 대상 조회 (락 없음). 동시 재발송은 아래 원자적 claim 으로 차단.
    const target = await this.buildResendQuery(orderDeliveryId).getOne();
    if (!target) {
      return { success: false, message: '이미 처리 중이거나 재발송 대상이 아닙니다.', orderDeliveryId };
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

    // 4. 원자적 claim (owner 토큰 = app 생성 claimAt). 30분 self-heal: 크래시로 남은 stale claim 만 재claim.
    const claimAt = new Date();
    const staleThreshold = new Date(claimAt.getTime() - 30 * 60 * 1000);
    const claimSet = { claimedAt: claimAt, ...(newTransactionId && { transactionId: newTransactionId }) };
    const claimResult = await this.orderDeliveryRepository
      .createQueryBuilder()
      .update(OrderDeliveryEntity)
      .set(claimSet)
      .where('id = :id', { id: orderDeliveryId })
      .andWhere('status IN (:...statuses)', { statuses: RESENDABLE_FAIL_STATUSES })
      .andWhere('(claimedAt IS NULL OR claimedAt < :stale)', { stale: staleThreshold })
      .execute();
    if (!claimResult.affected) {
      return { success: false, message: '이미 처리 중이거나 재발송 대상이 아닙니다.', orderDeliveryId };
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
      const sendSuccess = await this.deliveryBatchService.oneSend(orderDelivery);

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
    }
  }

  /** 재발송 대상 조회 쿼리(relation 포함, 재발송 가능 상태 필터). 락 없음. */
  private buildResendQuery(orderDeliveryId: number) {
    return this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .leftJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .leftJoinAndSelect('orderProductMapping.order', 'order')
      .leftJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .withDeleted()
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .andWhere('orderDelivery.status IN (:...statuses)', { statuses: RESENDABLE_FAIL_STATUSES });
  }

  /** claim 해제 (owner guard). 내가 소유한 claim(claimedAt=:claimAt)만 해제. */
  private async releaseClaim(orderDeliveryId: number, claimAt: Date): Promise<void> {
    await this.orderDeliveryRepository.update(
      { id: orderDeliveryId, claimedAt: claimAt },
      { claimedAt: null },
    );
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