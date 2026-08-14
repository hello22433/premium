import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import {
  RefundGetListReqQueryDto,
  RefundResetBatchReqDto,
  RefundResetReqDto,
  RefundUpdateBatchReqDto,
  RefundUpdateReqDto,
} from '../api/refund.req.dto';
import { In, IsNull, Not, Repository } from 'typeorm';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import { RefundGetListResDto } from '../api/refund.res.dto';
import { RefundListViewDto } from '../api/dto/refund.list.view.dto';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { MaskingUtil } from '../../common/utils/masking.util';
import { PhoneUtil } from '../../common/utils/phone.util';
import { OrderDeliveryRefundStatusEnum } from '../../delivery/interface/order.delivery.refund.status.enum';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogActionType } from '../../activity_log/interface/activity.log.action.type';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { readLineProductView } from '../../order/util/order.snapshot.builder';

export type RefundGetListAuditContext = {
  user: ILoginUserInfo;
  ipAddress: string;
  userAgent?: string;
};

@Injectable()
export class RefundService {
  constructor(
    private cryptoCipher: CryptoCipher,
    private activityLogService: ActivityLogService,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
  ) {}

  private logger = new Logger('REFUND_SERVICE');

  async getList(
    getDto: RefundGetListReqQueryDto,
    auditContext: RefundGetListAuditContext,
  ): Promise<RefundGetListResDto> {
    const { startAt, endAt, userBusinessName, userPersonName, refundStatus, deliveryTarget, page, take } = getDto;

    const queryBuilder = this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'company')
      .where('orderDelivery.refundStatus IS NOT NULL');

    QueryBuilderDateCondition(queryBuilder, 'orderDelivery', 'refundRegisterAt', startAt, endAt);

    if (userBusinessName) {
      queryBuilder.andWhere('company.businessName LIKE :userBusinessName', {
        userBusinessName: `%${userBusinessName}%`,
      });
    }

    if (userPersonName) {
      queryBuilder.andWhere('user.personName LIKE :userPersonName', { userPersonName: `%${userPersonName}%` });
    }

    if (refundStatus) {
      queryBuilder.andWhere('orderDelivery.refundStatus = :refundStatus', { refundStatus });
    }

    const trimmedDeliveryTarget = deliveryTarget?.trim();
    if (trimmedDeliveryTarget) {
      const normalizedTarget = PhoneUtil.normalizeDeliveryTarget(trimmedDeliveryTarget);
      const encryptedTarget = this.cryptoCipher.encryptDeliveryTarget(normalizedTarget);
      queryBuilder.andWhere(
        '(orderDelivery.deliveryTarget = :encryptedDeliveryTarget OR orderDelivery.emailReceiverPhone = :encryptedDeliveryTarget)',
        { encryptedDeliveryTarget: encryptedTarget },
      );

      await this.recordPiiSearchLog(trimmedDeliveryTarget, auditContext);
    }

    // COALESCE 순서와 반올림 없음은 아래 행 계산이 쓰는 readLineProductView(스냅샷 → live product → 0)를
    // SQL 로 복제한 것이다. 한쪽만 바뀌면 화면의 행 합과 상단 총합이 조용히 어긋난다.
    const sumResult = await queryBuilder
      .clone()
      .select(
        'SUM(COALESCE(orderProductMapping.snapshotProductPrice, product.price, 0) * orderDelivery.refundRatio / 100)',
        'totalRefundPrice',
      )
      .getRawOne();
    const totalRefundPrice = Number(sumResult?.totalRefundPrice) || 0;

    // 정렬: 접수일자 최신순(refundRegisterAt DESC), 동률 시 id DESC 보조키로 안정적 페이지네이션 보장
    // (MySQL은 DESC 정렬에서 NULL을 자동으로 뒤로 정렬하므로 NULLS LAST 절 불요)
    queryBuilder.orderBy('orderDelivery.refundRegisterAt', 'DESC').addOrderBy('orderDelivery.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder.skip(skip).take(take);
    const [orderDeliveryList, totalCount] = await queryBuilder.getManyAndCount();

    const resultList: RefundListViewDto[] = orderDeliveryList.map((orderDelivery) => {
      const decryptedDeliveryTarget = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget) ?? '';
      // D3-69: 라인 표시값을 주문시점 박제값으로 통일 — live product.*(가변)를 읽으면 상품 정보가
      // 수정될 때 환불목록이 주문시점 액면가·상품명과 다르게 표시된다.
      //  ※ price 뿐 아니라 name 까지 같은 view 에서 뽑는다(리뷰 반영). 가격만 박제하면 상품명 변경 시
      //    "새 상품명 + 옛 가격" 이 한 행에 섞여 담당자가 금액 오류로 오인할 수 있다. 환불율을 실제로
      //    설정하는 정산정보입력 화면(order.service readLineProductView)도 이미 snapshot 상품명을 쓴다.
      //  ※ deliveryPrice/refundPrice 는 '주문시점 액면가' 기준이다(할인·카드할증 반영 전이라 실납부액과 다름).
      const lineView = readLineProductView(orderDelivery.orderProductMapping!);

      return {
        id: orderDelivery.id,
        refundRegisterAt: format(orderDelivery.refundRegisterAt!, DateFormatStr),
        userBusinessName: orderDelivery.orderProductMapping!.order!.user!.company?.businessName ?? '',
        productName: lineView.name,
        deliveryPrice: lineView.price,
        sendRequestAt: format(orderDelivery.sendRequestAt, DateFormatStr),
        personalCode: orderDelivery.personalCode ? MaskingUtil.maskPersonalCode(orderDelivery.personalCode) : '-',
        deliveryTarget: decryptedDeliveryTarget,
        refundRatio: orderDelivery.refundRatio!,
        refundPrice: (lineView.price * orderDelivery.refundRatio!) / 100,
        bankAccountOwner: orderDelivery.bankAccountOwner,
        bankName: orderDelivery.bankName,
        bankAccount: this.cryptoCipher.safeDecryptAccountNumber(orderDelivery.bankAccount) ?? orderDelivery.bankAccount,
        approveAt: orderDelivery.approveAt ? format(orderDelivery.approveAt, DateFormatStr) : null,
        refundStatus: orderDelivery.refundStatus!,
        refundAt: orderDelivery.refundAt ? format(orderDelivery.refundAt, DateFormatStr) : null,
      };
    });

    return {
      list: resultList,
      totalPage: Math.ceil(totalCount / take),
      totalCount,
      currentPage: page,
      totalRefundPrice,
    };
  }

  private async recordPiiSearchLog(rawKeyword: string, auditContext: RefundGetListAuditContext): Promise<void> {
    const { user, ipAddress, userAgent } = auditContext;
    const maskedKeyword = MaskingUtil.maskDeliveryTarget(rawKeyword);

    try {
      await this.activityLogService.createLog({
        userId: user.id,
        userEmail: user.email,
        method: 'GET',
        requestUrl: '/settle/refund/list',
        actionType: ActivityLogActionType.PII_SEARCH,
        ipAddress,
        userAgent,
        statusCode: 200,
        result: ActivityLogResult.SUCCESS,
        responseTime: 0,
        requestParams: {
          screen: 'CUSTOMER_REFUND',
          searchType: 'deliveryTarget',
          maskedKeyword,
        },
      });
    } catch (error) {
      this.logger.error('Failed to record PII_SEARCH activity log', error instanceof Error ? error.stack : error);
    }
  }

  private static readonly REFUND_STATUS_ORDER: Record<OrderDeliveryRefundStatusEnum, number> = {
    [OrderDeliveryRefundStatusEnum.PROGRESS]: 0,
    [OrderDeliveryRefundStatusEnum.APPROVE]: 1,
    [OrderDeliveryRefundStatusEnum.COMPLETE]: 2,
  };

  async update(getDto: RefundUpdateReqDto) {
    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: { id: getDto.id, refundStatus: Not(IsNull()) },
    });

    if (!orderDelivery) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    this.applyRefundUpdate(orderDelivery, getDto);

    await this.orderDeliveryRepository.save(orderDelivery);
  }

  /**
   * 환불관리 업데이트 검증 + 필드 반영 (단건/일괄 공용).
   * 검증 실패 시 BadRequestException 을 던진다. caller 가 save 전에 호출하므로,
   * 일괄 처리에서 하나라도 throw 되면 save 가 실행되지 않아 전체가 반영되지 않는다(전부 거부).
   */
  private applyRefundUpdate(orderDelivery: OrderDeliveryEntity, dto: RefundUpdateReqDto): void {
    const { refundAt, refundStatus, bankAccountOwner, bankName, bankAccount, approveAt } = dto;

    const isProgress = refundStatus === OrderDeliveryRefundStatusEnum.PROGRESS;

    // 일자 결정: undefined=유지, null=클리어(PROGRESS만), 문자열=해당 날짜 (빈 문자열/형식오류는 DTO @Matches 에서 차단)
    const resolvedApproveAt = this.resolveRefundDate(approveAt, orderDelivery.approveAt, isProgress, '승인일자');
    const resolvedRefundAt = this.resolveRefundDate(refundAt, orderDelivery.refundAt, isProgress, '환불일자');

    // 결과 상태 불변조건
    if (refundStatus === OrderDeliveryRefundStatusEnum.APPROVE && !resolvedApproveAt) {
      throw new BadRequestException('승인 상태에서는 승인일자가 필요합니다.');
    }
    if (refundStatus === OrderDeliveryRefundStatusEnum.COMPLETE && (!resolvedApproveAt || !resolvedRefundAt)) {
      throw new BadRequestException('환불 완료 상태에서는 승인일자와 환불일자가 모두 필요합니다.');
    }
    if (resolvedApproveAt && resolvedRefundAt && resolvedRefundAt.getTime() < resolvedApproveAt.getTime()) {
      throw new BadRequestException('환불일자는 승인일자보다 빠를 수 없습니다.');
    }

    // 승인 이상 상태는 예금주/은행명/계좌번호 필수
    if (
      RefundService.REFUND_STATUS_ORDER[refundStatus] >=
      RefundService.REFUND_STATUS_ORDER[OrderDeliveryRefundStatusEnum.APPROVE]
    ) {
      if (!bankAccountOwner || !bankName || !bankAccount) {
        throw new BadRequestException('승인 시 예금주, 은행명, 계좌번호를 입력해주세요.');
      }
    }

    orderDelivery.refundStatus = refundStatus;
    orderDelivery.bankAccountOwner = bankAccountOwner ?? null;
    orderDelivery.bankName = bankName;
    orderDelivery.bankAccount = bankAccount ? this.cryptoCipher.encryptAccountNumber(bankAccount) : bankAccount;
    orderDelivery.approveAt = resolvedApproveAt;
    orderDelivery.refundAt = resolvedRefundAt;
  }

  /**
   * 환불 일자 입력값 해석.
   * - undefined / 키 미전송: 기존값 유지
   * - null: 컬럼 클리어. 단 결과 상태가 PROGRESS 일 때만 허용, 아니면 400
   * - 유효 날짜 문자열(DTO @Matches 통과): 해당 날짜
   */
  private resolveRefundDate(
    incoming: string | null | undefined,
    current: Date | null,
    isProgress: boolean,
    fieldLabel: string,
  ): Date | null {
    if (incoming === undefined) {
      return current;
    }
    if (incoming === null) {
      if (!isProgress) {
        throw new BadRequestException(`${fieldLabel}는 진행중 상태에서만 비울 수 있습니다.`);
      }
      return null;
    }
    return new Date(incoming);
  }

  /**
   * 환불관리 일괄 저장. items 각 항목을 검증 후 한 번에 save.
   * 하나라도 검증 실패(존재하지 않음/중복/상태 조건)면 throw → 아무것도 저장되지 않는다.
   * save(배열)은 TypeORM 기본 단일 트랜잭션이라 부분 저장이 발생하지 않는다.
   */
  async updateBatch(dto: RefundUpdateBatchReqDto) {
    const ids = dto.items.map((item) => item.id);
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) {
      throw new BadRequestException('중복된 주문 id가 있습니다.');
    }

    const orders = await this.orderDeliveryRepository.find({
      where: { id: In(uniqueIds), refundStatus: Not(IsNull()) },
    });
    const orderById = new Map(orders.map((order) => [order.id, order]));

    const missing = ids.filter((id) => !orderById.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(`주문이 존재하지 않습니다. (id: ${missing.join(', ')})`);
    }

    // 전부 검증 통과 후에만 save 하도록 검증/반영을 먼저 모두 수행한다.
    for (const item of dto.items) {
      this.applyRefundUpdate(orderById.get(item.id)!, item);
    }

    await this.orderDeliveryRepository.save([...orderById.values()]);
  }

  async reset(getDto: RefundResetReqDto) {
    const { id } = getDto;

    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: { id, refundStatus: Not(IsNull()) },
    });

    if (!orderDelivery) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    if (orderDelivery.refundStatus !== OrderDeliveryRefundStatusEnum.PROGRESS) {
      throw new BadRequestException('진행중 상태의 환불만 초기화할 수 있습니다.');
    }

    this.clearRefundInputFields(orderDelivery);

    await this.orderDeliveryRepository.save(orderDelivery);
  }

  /**
   * 환불관리 진행중 행 입력값 일괄 초기화.
   * 대상 중 하나라도 존재하지 않거나 PROGRESS 가 아니면 throw → 아무것도 저장되지 않는다(전부 거부).
   * save(배열)은 TypeORM 기본 단일 트랜잭션이라 부분 저장이 발생하지 않는다.
   */
  async resetBatch(dto: RefundResetBatchReqDto) {
    const ids = [...new Set(dto.ids)];

    const orders = await this.orderDeliveryRepository.find({
      where: { id: In(ids), refundStatus: Not(IsNull()) },
    });
    const foundIds = new Set(orders.map((order) => order.id));

    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(`주문이 존재하지 않습니다. (id: ${missing.join(', ')})`);
    }

    const nonProgress = orders.filter((order) => order.refundStatus !== OrderDeliveryRefundStatusEnum.PROGRESS);
    if (nonProgress.length > 0) {
      throw new BadRequestException(
        `진행중 상태의 환불만 초기화할 수 있습니다. (id: ${nonProgress.map((order) => order.id).join(', ')})`,
      );
    }

    for (const order of orders) {
      this.clearRefundInputFields(order);
    }

    await this.orderDeliveryRepository.save(orders);
  }

  /**
   * 환불관리 입력값 5개 필드를 null 로 비운다 (refundStatus 는 유지). 단건/일괄 공용.
   */
  private clearRefundInputFields(orderDelivery: OrderDeliveryEntity): void {
    orderDelivery.bankAccountOwner = null;
    orderDelivery.bankName = null;
    orderDelivery.bankAccount = null;
    orderDelivery.approveAt = null;
    orderDelivery.refundAt = null;
  }
}
