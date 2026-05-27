import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { RefundGetListReqQueryDto, RefundResetReqDto, RefundUpdateReqDto } from '../api/refund.req.dto';
import { IsNull, Not, Repository } from 'typeorm';
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

  async getList(getDto: RefundGetListReqQueryDto, auditContext: RefundGetListAuditContext): Promise<RefundGetListResDto> {
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
      queryBuilder.andWhere('company.businessName LIKE :userBusinessName', { userBusinessName: `%${userBusinessName}%` });
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

    // 정렬: 접수일자 최신순(refundRegisterAt DESC), 동률 시 id DESC 보조키로 안정적 페이지네이션 보장
    // (MySQL은 DESC 정렬에서 NULL을 자동으로 뒤로 정렬하므로 NULLS LAST 절 불요)
    queryBuilder
      .orderBy('orderDelivery.refundRegisterAt', 'DESC')
      .addOrderBy('orderDelivery.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder.skip(skip).take(take);
    const [orderDeliveryList, totalCount] = await queryBuilder.getManyAndCount();

    const resultList: RefundListViewDto[] = orderDeliveryList.map((orderDelivery) => {
      const decryptedDeliveryTarget = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget) ?? '';

      return {
        id: orderDelivery.id,
        refundRegisterAt: format(orderDelivery.refundRegisterAt!, DateFormatStr),
        userBusinessName: orderDelivery.orderProductMapping!.order!.user!.company?.businessName ?? '',
        productName: orderDelivery.orderProductMapping!.product.name,
        deliveryPrice: orderDelivery.orderProductMapping!.product.price,
        sendRequestAt: format(orderDelivery.sendRequestAt, DateFormatStr),
        personalCode: orderDelivery.personalCode ? MaskingUtil.maskPersonalCode(orderDelivery.personalCode) : '-',
        deliveryTarget: decryptedDeliveryTarget,
        refundRatio: orderDelivery.refundRatio!,
        refundPrice: (orderDelivery.orderProductMapping!.product.price * orderDelivery.refundRatio!) / 100,
        bankAccountOwner: orderDelivery.bankAccountOwner,
        bankName: orderDelivery.bankName,
        bankAccount: orderDelivery.bankAccount,
        approveAt: orderDelivery.approveAt ? format(orderDelivery.approveAt, DateFormatStr) : null,
        refundStatus: orderDelivery.refundStatus!,
        refundAt: orderDelivery.refundAt ? format(orderDelivery.refundAt, DateFormatStr) : null,
      };
    });

    return { list: resultList, totalPage: Math.ceil(totalCount / take), totalCount, currentPage: page };
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
    const { id, refundAt, refundStatus, bankAccountOwner, bankName, bankAccount, approveAt } = getDto;

    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: { id, refundStatus: Not(IsNull()) },
    });

    if (!orderDelivery) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    const isUpward = RefundService.REFUND_STATUS_ORDER[refundStatus] > RefundService.REFUND_STATUS_ORDER[orderDelivery.refundStatus!];

    if (isUpward) {
      if (RefundService.REFUND_STATUS_ORDER[refundStatus] >= RefundService.REFUND_STATUS_ORDER[OrderDeliveryRefundStatusEnum.APPROVE]) {
        if (!bankAccountOwner || !bankName || !bankAccount || !approveAt) {
          throw new BadRequestException('승인 시 예금주, 은행명, 계좌번호, 승인일자를 입력해주세요.');
        }
      }
      if (refundStatus === OrderDeliveryRefundStatusEnum.COMPLETE && !refundAt) {
        throw new BadRequestException('환불 완료 시 환불일자를 입력해주세요.');
      }
    }

    orderDelivery.refundStatus = refundStatus;
    orderDelivery.bankAccountOwner = bankAccountOwner ?? null;
    orderDelivery.bankName = bankName;
    orderDelivery.bankAccount = bankAccount;
    orderDelivery.approveAt = approveAt ? new Date(approveAt) : orderDelivery.approveAt;
    orderDelivery.refundAt = refundAt ? new Date(refundAt) : orderDelivery.refundAt;

    await this.orderDeliveryRepository.save(orderDelivery);
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

    orderDelivery.bankAccountOwner = null;
    orderDelivery.bankName = null;
    orderDelivery.bankAccount = null;
    orderDelivery.approveAt = null;
    orderDelivery.refundAt = null;

    await this.orderDeliveryRepository.save(orderDelivery);
  }
}
