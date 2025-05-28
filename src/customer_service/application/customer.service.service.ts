import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CustomerServiceCouponRefreshReqDto,
  CustomerServiceDiscardReqDto,
  CustomerServiceGetDetailListReqDto,
  CustomerServiceGetListReqDto,
  CustomerServiceReSendReqDto,
} from '../api/customer.service.req.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderEntity } from '../../entity/order.entity';
import { Repository } from 'typeorm';
import { CustomerServiceGetListResDto } from '../api/customer.service.res.dto';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { CustomerServiceViewDto } from '../api/dto/customer.service.view.dto';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { CustomerServiceDetailViewDto } from '../api/dto/customer.service.detail.view.dto';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { DeliveryBatchService } from '../../delivery/application/delivery.batch.service';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';

@Injectable()
export class CustomerServiceService {
  constructor(
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderProductMappingEntity)
    private orderProductMappingRepository: Repository<OrderProductMappingEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    private partnerCompanyExternService: PartnerCompanyExternService,
    private deliveryBatchService: DeliveryBatchService,
  ) {}

  async getList(getQuery: CustomerServiceGetListReqDto): Promise<CustomerServiceGetListResDto> {
    const { orderType, startAt, endAt, userId, status, orderNumber, eventName, productName, productCode, page, take } =
      getQuery;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .innerJoinAndSelect('orderProductMappings.product', 'product');

    if (orderType === 'GENERAL') {
      queryBuilder.andWhere('product.type = :type', { type: 'GENERAL' });
    }

    if (orderType === 'SSG') {
      queryBuilder.andWhere('product.type = :type', { type: 'SSG' });
    }

    if (userId) {
      queryBuilder.andWhere('order.userId = :userId', { userId });
    }

    if (orderNumber) {
      queryBuilder.andWhere('order.id = :id', { id: +orderNumber });
    }

    if (status) {
      queryBuilder.andWhere('order.status = :status', { status });
    }

    if (eventName) {
      queryBuilder.andWhere('order.eventName LIKE :eventName', { eventName: `%${eventName}%` });
    }

    if (productName) {
      queryBuilder.andWhere('product.productName LIKE :productName', { productName: `%${productName}%` });
    }

    if (productCode) {
      queryBuilder.andWhere('product.code LIKE :productCode', { productCode: `%${productCode}%` });
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'order', 'sendRequestAt', startAt, endAt);

    const skip = (page - 1) * take;
    queryBuilder.take(take).skip(skip);
    queryBuilder.orderBy('order.id', 'DESC');
    const [orderList, totalCount] = await queryBuilder.getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const result: CustomerServiceViewDto[] = [];
    for (const order of orderList) {
      result.push({
        sendRequestAt: format(order.sendRequestAt, DateFormatStr),
        id: order.id,
        orderProductMappingId: order.orderProductMappings![0].id,
        eventName: order.eventName,
        productName: order.orderProductMappings![0].product.name,
        productCode: order.orderProductMappings![0].product.code,
        status: order.status,
        fromPhoneNumber: order.fromPhoneNumber,
        fromEmail: order.fromEmail,
        couponStatus: order.orderProductMappings![0].orderDeliveries![0].couponStatus,
      });
    }

    return {
      list: result,
      totalCount,
      totalPage,
      currentPage: page,
    };
  }

  async getDetailList(getQuery: CustomerServiceGetDetailListReqDto) {
    const { orderId, page, take } = getQuery;

    const queryBuilder = this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .where('order.id = :orderId', {
        orderId: orderId,
      });
    const skip = (page - 1) * take;
    queryBuilder.take(take).skip(skip);
    queryBuilder.orderBy('orderDelivery.id', 'DESC');
    const [orderDeliveryList, totalCount] = await queryBuilder.getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const result: CustomerServiceDetailViewDto[] = orderDeliveryList.map((orderDelivery) => {
      return {
        id: orderDelivery.id,
        eventName: orderDelivery.orderProductMapping.order.eventName,
        productName: orderDelivery.orderProductMapping.product.name,
        registerAt: format(orderDelivery.createdAt, DateFormatStr),
        deliveryTarget: orderDelivery.deliveryTarget,
        tradeAt: orderDelivery.tradeAt ? format(orderDelivery.tradeAt, DateFormatStr) : null,
        status: orderDelivery.status,
        method: orderDelivery.deliveryMethod,
        brandName: orderDelivery.orderProductMapping.product.brand!.nameKorean ?? '',
        couponStatus: orderDelivery.couponStatus,
      };
    });

    return {
      list: result,
      totalCount,
      totalPage,
      currentPage: page,
    };
  }

  async reSend(getBody: CustomerServiceReSendReqDto) {
    const { orderDeliveryId } = getBody;

    const queryBuilder = this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('order.user', 'user')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .andWhere('orderDelivery.status IN (:...status)', { status: ['COMPLETE', 'FAIL', 'COMPLETE_SMS', 'FAIL_SMS'] })
      .andWhere('orderDelivery.id = :orderDeliveryId', { orderDeliveryId: orderDeliveryId });

    const orderDelivery = await queryBuilder.getOne();

    if (!orderDelivery) {
      throw new BadRequestException('주문 발송가 존재하지 않습니다.');
    }

    if (orderDelivery.deliveryTarget === '000-0000-0000' || orderDelivery.deliveryTarget === '') {
      throw new BadRequestException('파기된 발송 정보입니다.');
    }

    await this.deliveryBatchService.oneSend(orderDelivery);

    return;
  }

  async pinDiscard(getBody: CustomerServiceDiscardReqDto) {
    const { orderDeliveryId } = getBody;

    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .where('orderDelivery.id = :orderDeliveryId', { orderDeliveryId: orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 주문 건입니다.');
    }

    orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
    await this.partnerCompanyExternService.cancel(orderDelivery);
    await this.orderDeliveryRepository.save(orderDelivery);

    return;
  }

  async refreshCoupon(getQuery: CustomerServiceCouponRefreshReqDto) {
    const { orderDeliveryId } = getQuery;

    const orderDelivery = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .where('orderDelivery.id = :orderDeliveryId', { orderDeliveryId })
      .getOne();

    if (!orderDelivery) {
      throw new BadRequestException('존재하지 않는 orderDelivery 입니다.');
    }

    // 실시간 외부사 조회 → couponStatus 갱신
    const updated = await this.partnerCompanyExternService.refreshCouponStatus(orderDelivery);

    return {
      id: updated.id,
      couponStatus: updated.couponStatus,
      tradeAt: updated.tradeAt,
    };
  }
}
