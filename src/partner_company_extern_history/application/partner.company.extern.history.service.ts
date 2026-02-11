import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { GetPartnerCompanyExternHistoryListReqDto } from '../api/partner.company.extern.history.req.dto';
import {
  GetPartnerCompanyExternHistoryListResDto,
  PartnerCompanyExternHistoryViewDto,
  GetPartnerCompanyTypesResDto,
  ResendResultDto,
  FailType,
} from '../api/partner.company.extern.history.res.dto';
import { format } from 'date-fns';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
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
    @InjectRepository(SsgEventEntity)
    private ssgEventRepository: Repository<SsgEventEntity>,
    private cryptoCipher: CryptoCipher,
    @Inject(forwardRef(() => PartnerCompanyExternService))
    private partnerCompanyExternService: PartnerCompanyExternService,
    @Inject(forwardRef(() => DeliveryBatchService))
    private deliveryBatchService: DeliveryBatchService,
  ) {}

  /**
   * 발송 실패 내역 목록 조회
   * orderDelivery.status = FAIL 기준으로 조회 (중복 없이 최종 실패 건만)
   */
  async getHistoryList(dto: GetPartnerCompanyExternHistoryListReqDto): Promise<GetPartnerCompanyExternHistoryListResDto> {
    const { startAt, endAt, type, searchKeyword, page, take } = dto;

    // orderDelivery 기준으로 조회 (status = FAIL)
    // 정렬용 가상 컬럼: actualSendAt 우선, 없으면 updatedAt (핀발급실패 시 actualSendAt이 NULL)
    const dateCoalesceExpr = 'COALESCE(`orderDelivery`.`actual_send_at`, `orderDelivery`.`updated_at`)';
    let queryBuilder = this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .addSelect(dateCoalesceExpr, 'sortDate')
      .leftJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .leftJoinAndSelect('orderProductMapping.order', 'order')
      .leftJoinAndSelect('orderProductMapping.product', 'product')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .where('orderDelivery.deletedAt IS NULL')
      .andWhere('orderDelivery.status IN (:...statuses)', { statuses: RESENDABLE_FAIL_STATUSES });

    // 기간 필터 (actualSendAt이 없는 경우 updatedAt으로 대체)
    const dateColumn = 'COALESCE(orderDelivery.actualSendAt, orderDelivery.updatedAt)';
    if (startAt) {
      queryBuilder.andWhere(`${dateColumn} >= :startAt`, { startAt: `${startAt} 00:00:00` });
    }
    if (endAt) {
      queryBuilder.andWhere(`${dateColumn} <= :endAt`, { endAt: `${endAt} 23:59:59` });
    }

    // 협력사 타입 필터
    if (type) {
      queryBuilder.andWhere('partnerCompany.type = :type', { type });
    }

    // 키워드 검색 (주문코드, 이벤트명)
    if (searchKeyword) {
      queryBuilder.andWhere(
        '(order.code LIKE :searchKeyword OR order.eventName LIKE :searchKeyword)',
        { searchKeyword: `%${searchKeyword}%` },
      );
    }

    // 페이징 및 정렬 (actualSendAt 우선, 없으면 updatedAt)
    const skip = (page - 1) * take;
    queryBuilder.orderBy('sortDate', 'DESC').skip(skip).take(take);

    const [orderDeliveries, totalCount] = await queryBuilder.getManyAndCount();

    // DTO 변환 (가장 최근 history에서 에러 정보 가져옴)
    const list: PartnerCompanyExternHistoryViewDto[] = await Promise.all(
      orderDeliveries.map((od) => this.parseOrderDeliveryView(od)),
    );

    return {
      list,
      totalCount,
      totalPage: Math.ceil(totalCount / take),
      currentPage: page,
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
   * orderDelivery를 View DTO로 변환
   * 가장 최근 history에서 에러 정보를 가져옴
   */
  private async parseOrderDeliveryView(orderDelivery: OrderDeliveryEntity): Promise<PartnerCompanyExternHistoryViewDto> {
    // 협력사 타입
    const partnerCompanyType = orderDelivery.orderProductMapping?.product?.partnerCompany?.type || null;

    // 핀 발급 여부 (barCode 유무로 판단)
    const pinIssued = !!orderDelivery.barCode;

    // 실패 유형 결정 (SSG는 하단에서 history 기반으로 보정)
    let failType = pinIssued ? FailType.SEND_FAIL : FailType.PIN_ISSUE_FAIL;
    let failTypeKo = pinIssued ? '발송실패' : '핀발급실패';

    // 수신처 마스킹 처리
    let deliveryTarget: string | null = null;
    if (orderDelivery.deliveryTarget) {
      try {
        const decrypted = this.cryptoCipher.decryptDeliveryTarget(orderDelivery.deliveryTarget);
        deliveryTarget = this.maskDeliveryTarget(decrypted);
      } catch {
        deliveryTarget = this.maskDeliveryTarget(orderDelivery.deliveryTarget);
      }
    }

    // 주문 정보
    const orderCode = orderDelivery.orderProductMapping?.order?.code || null;
    const eventName = orderDelivery.orderProductMapping?.order?.eventName || null;

    // 가장 최근 history에서 에러 정보 가져오기
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    let transactionId: string | null = orderDelivery.transactionId || null;
    let context: string | null = null;

    const latestHistory = await this.historyRepository.findOne({
      where: { orderDeliveryId: orderDelivery.id },
      order: { createdAt: 'DESC' },
    });

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
    if (partnerCompanyType === IPartnerCompanyType.SSG && latestHistory && !latestHistory.isSuccess) {
      failType = FailType.PIN_ISSUE_FAIL;
      failTypeKo = '핀발급실패';
    }

    // 핀은 발급됐지만 발송 실패인 경우, history가 없을 수 있음 (발송 실패는 delivery_send_history에 기록)
    if (pinIssued && !errorMessage) {
      errorMessage = '문자/알림톡 발송 실패';
    }

    const displayDate = orderDelivery.actualSendAt ?? orderDelivery.updatedAt;

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
   */
  async resendFailedDelivery(orderDeliveryId: number): Promise<ResendResultDto> {
    try {
      // 1. orderDelivery 조회 (발송에 필요한 모든 relation 포함)
      const orderDelivery = await this.orderDeliveryRepository.findOne({
        where: { id: orderDeliveryId },
        relations: [
          'orderProductMapping',
          'orderProductMapping.order',
          'orderProductMapping.order.user',
          'orderProductMapping.product',
          'orderProductMapping.product.brand',
          'orderProductMapping.product.partnerCompany',
        ],
      });

      if (!orderDelivery) {
        return {
          success: false,
          message: `orderDelivery를 찾을 수 없습니다. id: ${orderDeliveryId}`,
          orderDeliveryId,
        };
      }

      // 2. 실패 상태인지 확인 (FAIL 또는 FAIL_SMS)
      if (!RESENDABLE_FAIL_STATUSES.includes(orderDelivery.status)) {
        return {
          success: false,
          message: `해당 건은 발송 실패 상태가 아닙니다. 현재 상태: ${orderDelivery.status}`,
          orderDeliveryId,
        };
      }

      // 3. 핀 발급 여부 판단 (barCode 유무 + 유효성 확인)
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

      // 4. 재발송 처리
      // SSG는 barCode가 있어도 SSG DB에 미등록 상태일 수 있으므로 항상 issue() 거침
      const needsPinIssue = !pinIssued || partnerCompanyType === IPartnerCompanyType.SSG;

      // PIN이 이미 발급됨 (SSG 제외) → 발송만 재시도
      if (!needsPinIssue) {
        const sendSuccess = await this.deliveryBatchService.oneSend(orderDelivery);
        return {
          success: sendSuccess,
          message: sendSuccess
            ? '재발송 성공 (기존 발급된 핀으로 발송)'
            : '발송 실패 - 알림톡/SMS/이메일 발송에 실패했습니다.',
          orderDeliveryId,
        };
      }

      // PIN 미발급 → 핀 발급 + 발송
      // 재발급 시 transactionId 갱신 (협력사 거래번호 중복 방지)
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

      // SSG의 경우 ssgEvent 필요
      let ssgEvent: SsgEventEntity | null = null;
      if (partnerCompanyType === IPartnerCompanyType.SSG && orderDelivery.ssgEventId) {
        ssgEvent = await this.ssgEventRepository.findOne({
          where: { id: orderDelivery.ssgEventId },
        });

        if (!ssgEvent) {
          return {
            success: false,
            message: 'SSG 이벤트 정보를 찾을 수 없습니다.',
            orderDeliveryId,
          };
        }
      }

      // PIN 발급
      await this.partnerCompanyExternService.issue(orderDelivery, ssgEvent);

      // PIN 발급 성공 확인
      if (!orderDelivery.barCode) {
        return {
          success: false,
          message: 'PIN 발급에 실패했습니다.',
          orderDeliveryId,
        };
      }

      // SSG는 issue()에서 SSG DB INSERT 시 발송도 처리됨
      // 다른 협력사는 별도로 발송 필요
      if (partnerCompanyType !== IPartnerCompanyType.SSG) {
        const sendSuccess = await this.deliveryBatchService.oneSend(orderDelivery);

        if (!sendSuccess) {
          return {
            success: false,
            message: 'PIN 발급 성공, 발송 실패 - 알림톡/SMS/이메일 발송에 실패했습니다.',
            orderDeliveryId,
          };
        }
      }

      return {
        success: true,
        message: '재발송 성공 (PIN 발급 + 발송)',
        orderDeliveryId,
      };
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