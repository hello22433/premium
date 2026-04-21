import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
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
   * 발송 실패 건 재발송
   * - PIN 미발급 (barCode 없음): issue() + oneSend() - 핀 발급 후 발송
   * - PIN 발급됨 (barCode 있음): oneSend() 만 - 발송만 재시도
   *
   * 비관적 락(SELECT FOR UPDATE)으로 동시 재발송 Race Condition 방지:
   * - 첫 번째 요청: 락 획득 → 재발송 처리 → status 변경 → 커밋 → 락 해제
   * - 두 번째 요청: 락 대기 → 획득 후 status 확인 → 이미 COMPLETE → 재발송 불가 반환
   */
  @Transactional()
  async resendFailedDelivery(orderDeliveryId: number): Promise<ResendResultDto> {
    try {
      // 1. 비관적 락으로 orderDelivery 조회 (동시 재발송 방지)
      // WHERE 조건에 실패 상태 포함 → 이미 처리된 건은 조회되지 않음
      const orderDelivery = await this.orderDeliveryRepository
        .createQueryBuilder('orderDelivery')
        .setLock('pessimistic_write')
        .leftJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
        .leftJoinAndSelect('orderProductMapping.order', 'order')
        .leftJoinAndSelect('order.user', 'user')
        .leftJoinAndSelect('orderProductMapping.product', 'product')
        .leftJoinAndSelect('product.brand', 'brand')
        .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
        .withDeleted()
        .where('orderDelivery.id = :id', { id: orderDeliveryId })
        .andWhere('orderDelivery.status IN (:...statuses)', { statuses: RESENDABLE_FAIL_STATUSES })
        .getOne();

      if (!orderDelivery) {
        return {
          success: false,
          message: '이미 처리 중이거나 재발송 대상이 아닙니다.',
          orderDeliveryId,
        };
      }

      if (
        orderDelivery.orderProductMapping.product.type === IProductType.CHOICE &&
        orderDelivery.orderProductMapping.product.deletedAt
      ) {
        return {
          success: false,
          message: '삭제된 초이스 쿠폰은 재발송할 수 없습니다.',
          orderDeliveryId,
        };
      }

      // 2. 핀 발급 여부 판단 (barCode 유무 + 유효성 확인)
      // barCode에 한글이 포함된 경우 에러 메시지가 저장된 것이므로 무효 처리
      if (orderDelivery.barCode && /[가-힣]/.test(orderDelivery.barCode)) {
        this.logger.warn(
          `[resendFailedDelivery] barCode에 잘못된 값 감지, 초기화: "${orderDelivery.barCode}" (orderDeliveryId: ${orderDeliveryId})`,
        );
        orderDelivery.barCode = null;
      }
      const pinIssued = !!orderDelivery.barCode;
      const partnerCompanyType = orderDelivery.orderProductMapping?.product?.partnerCompany?.type;

      this.logger.log(
        `[resendFailedDelivery] orderDeliveryId: ${orderDeliveryId}, pinIssued: ${pinIssued}, partnerCompanyType: ${partnerCompanyType}`,
      );

      // 3. 재발송 처리
      // SSG는 barCode가 있어도 SSG DB에 미등록 상태일 수 있으므로 oneSend() 내부에서 재확인
      const needsPinIssue = !pinIssued || partnerCompanyType === IPartnerCompanyType.SSG;

      // 재발급이 필요한 경우 transactionId 갱신 (협력사 거래번호 중복 방지)
      // 컬처랜드는 실패 응답에도 내부적으로 PIN이 발급된 상태이므로 기존 transactionId 유지
      if (needsPinIssue && partnerCompanyType !== IPartnerCompanyType.CULTURELAND) {
        const orderId = orderDelivery.orderProductMapping?.order?.id;
        if (!orderId) {
          return {
            success: false,
            message: '주문 정보를 찾을 수 없습니다.',
            orderDeliveryId,
          };
        }
        const retryMatch = orderDelivery.transactionId?.match(/R(\d+)$/);
        const retryCount = retryMatch ? parseInt(retryMatch[1], 10) + 1 : 1;
        orderDelivery.transactionId = CreateResendTransactionId(orderId, orderDeliveryId, retryCount);

        this.logger.log(
          `[resendFailedDelivery] transactionId 갱신: ${orderDelivery.transactionId}`,
        );
      }

      // oneSend()가 PIN 발급(필요시) + 이미지 생성 + 실제 발송을 모두 처리
      // - PIN 미발급: reissuePinAndCreateImageIfNeeded() → issue() → 이미지 생성 → 발송
      // - SSG: SSG DB 등록 여부 확인 후 필요시 INSERT → 이미지 생성 → 발송
      // - PIN 발급됨 (비SSG): 이미지 확인 → 발송만 재시도
      const sendSuccess = await this.deliveryBatchService.oneSend(orderDelivery);

      if (sendSuccess) {
        orderDelivery.resendAt = new Date();
        await this.orderDeliveryRepository.save(orderDelivery);
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
      const error = e instanceof Error ? e : new Error(String(e));
      this.logger.error(`[resendFailedDelivery] 재발송 실패: ${error.message}`, error.stack);
      return {
        success: false,
        message: error.message || '재발송 중 오류가 발생했습니다.',
        orderDeliveryId,
      };
    }
  }
}