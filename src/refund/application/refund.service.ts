import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { RefundGetListReqQueryDto, RefundUpdateReqDto } from '../api/refund.req.dto';
import { IsNull, Not, Repository } from 'typeorm';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import { RefundGetListResDto } from '../api/refund.res.dto';
import { RefundListViewDto } from '../api/dto/refund.list.view.dto';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { MaskingUtil } from '../../common/utils/masking.util';
import { OrderDeliveryRefundStatusEnum } from '../../delivery/interface/order.delivery.refund.status.enum';

@Injectable()
export class RefundService {
  constructor(
    private cryptoCipher: CryptoCipher,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
  ) {}

  private logger = new Logger('REFUND_SERVICE');

  async getList(getDto: RefundGetListReqQueryDto): Promise<RefundGetListResDto> {
    const { startAt, endAt, userBusinessName, userPersonName, refundStatus, page, take } = getDto;

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
        refundStatus: orderDelivery.refundStatus!,
        refundAt: orderDelivery.refundAt ? format(orderDelivery.refundAt, DateFormatStr) : null,
      };
    });

    return { list: resultList, totalPage: Math.ceil(totalCount / take), totalCount, currentPage: page };
  }

  async update(getDto: RefundUpdateReqDto) {
    const { id, refundAt, refundStatus, bankAccountOwner, bankName, bankAccount } = getDto;

    if (refundStatus === OrderDeliveryRefundStatusEnum.COMPLETE && !refundAt) {
      throw new BadRequestException('환불 완료 시 일자를 입력해주세요.');
    }

    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: { id, refundStatus: Not(IsNull()) },
    });

    if (!orderDelivery) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    orderDelivery.refundAt = refundAt ? new Date(refundAt) : null;
    orderDelivery.refundStatus = refundStatus;
    orderDelivery.bankAccountOwner = bankAccountOwner ?? null;
    orderDelivery.bankName = bankName;
    orderDelivery.bankAccount = bankAccount;

    await this.orderDeliveryRepository.save(orderDelivery);
  }
}
