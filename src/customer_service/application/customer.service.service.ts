import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import {
  CustomerServiceCouponRefreshReqDto,
  CustomerServiceDiscardReqDto,
  CustomerServiceGetDetailListReqDto,
  CustomerServiceGetDetailReqDto,
  CustomerServiceGetListReqDto,
  CustomerServicePinStatusModifyReqDto,
  CustomerServicePinStatusRefreshReqDto,
  CustomerServiceReSendReqDto,
  CustomerServiceStatusListReqDto,
  CustomerServiceStatusReqDto,
  UpdateCouponStatusReqDto,
} from '../api/customer.service.req.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderEntity } from '../../entity/order.entity';
import { IsNull, Repository } from 'typeorm';
import { CustomerServiceGetListResDto } from '../api/customer.service.res.dto';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { CustomerServiceViewDto } from '../api/dto/customer.service.view.dto';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { CustomerServiceDetailViewDto } from '../api/dto/customer.service.detail.view.dto';
import { CustomerServiceDlvryDetailViewDto } from '../api/dto/customer.service.dlvry.detail.view.dto';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { DeliveryBatchService } from '../../delivery/application/delivery.batch.service';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { ILoginUserInfo } from 'src/auth/interface/login.user';
import { OrderHistoryEntity } from 'src/entity/order.history.entity';
import { isEmpty } from 'lodash';
import { IOrderDeliveryStatus } from 'src/delivery/interface/order.delivery.status';
import { User } from 'src/auth/api/user.decorator';

@Injectable()
export class CustomerServiceService {
  dataSource: any;
  constructor(
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderProductMappingEntity)
    private orderProductMappingRepository: Repository<OrderProductMappingEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    private partnerCompanyExternService: PartnerCompanyExternService,
    private deliveryBatchService: DeliveryBatchService,
    @InjectRepository(OrderHistoryEntity)
    private orderHistoryEntity: Repository<OrderHistoryEntity>,
    @InjectRepository(OrderHistoryEntity)
    private readonly orderHistoryRepository: Repository<OrderHistoryEntity>,
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
        couponStatus: order.orderProductMappings?.[0]?.orderDeliveries?.[0]?.couponStatus ?? OrderDeliveryCouponStatus.NOT_USED,

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
      .leftJoinAndMapOne(
        'product.partnerCompany',
        'partner_company',
        'partnerCompany',
        'partnerCompany.id = product.partner_company_id'
      )
      .where('order.id = :orderId', {
        orderId: orderId,
      });
    const skip = (page - 1) * take;
    queryBuilder.take(take).skip(skip);
    
    const [orderDeliveryList, totalCount] = await queryBuilder.getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const result: CustomerServiceDetailViewDto[] = orderDeliveryList.map((orderDelivery) => {
      return {
        id: orderDelivery.id,
        registerAt: format(orderDelivery.createdAt, DateFormatStr),
        productName: orderDelivery.orderProductMapping.product.name,
        deliveryTarget: orderDelivery.deliveryTarget,
        barCode: orderDelivery.barCode,
        brandName: orderDelivery.orderProductMapping.product.brand!.nameKorean ?? '',
        partnerCompanyName: orderDelivery.orderProductMapping.product.partnerCompany?.businessName ?? '',
        eventName: orderDelivery.orderProductMapping.order.eventName,
        sendRequestAt: orderDelivery.sendRequestAt ? format(orderDelivery.sendRequestAt, DateFormatStr) : null,
        tradeAt: orderDelivery.tradeAt ? format(orderDelivery.tradeAt, DateFormatStr) : null,
        status: orderDelivery.status,
        couponStatus: orderDelivery.couponStatus,
        apiErrorMessage: orderDelivery.apiErrorMessage,
        method: orderDelivery.deliveryMethod,
      };
    });

    return {
      list: result,
      totalCount,
      totalPage,
      currentPage: page,
    };
  }

  async getDetail(getQuery: CustomerServiceGetDetailReqDto): Promise<CustomerServiceDlvryDetailViewDto> {
    const { orderDeliveryId } = getQuery;

    const queryBuilder = await this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndMapOne(
        'product.partnerCompany',
        'partner_company',
        'partnerCompany',
        'partnerCompany.id = product.partner_company_id AND partnerCompany.deleted_at IS NULL'
      )
      .leftJoinAndMapOne(
        'order.user',
        'user',
        'user',
        'user.id = order.user_id AND user.deleted_at IS NULL'
      )
      .where('orderDelivery.id = :id', { id: orderDeliveryId })
      .andWhere('orderDelivery.deletedAt IS NULL')
      .getOne();

    if (!queryBuilder) {
      throw new BadRequestException('존재하지 않는 발송 정보입니다.');
    }

    const product = queryBuilder.orderProductMapping.product;
    const partnerCompany = product.partnerCompany;
    const order = queryBuilder.orderProductMapping.order;
    const user = queryBuilder.orderProductMapping.order.user;

    return {
      orderDeliveryId: queryBuilder.id,
      eventName: order.eventName,
      businessName: partnerCompany?.businessName ?? '',
      personName: user?.personName ?? '',
      sendContent: order.sendContent,
      deliveryTarget: queryBuilder.deliveryTarget,
      sendRequestAt: queryBuilder.sendRequestAt ? format(queryBuilder.sendRequestAt, DateFormatStr) : null,
      method: queryBuilder.deliveryMethod,
      fromPhoneNumber: order.fromPhoneNumber,
      partnerCompanyName: partnerCompany?.businessName ?? '',
      productName: product.name,
      price: product.price.toString(),
      brandName: product.brand?.nameKorean ?? '',
      code: product.code,
      couponStatus: queryBuilder.couponStatus,
      status: queryBuilder.status,
      apiErrorMessage: queryBuilder.apiErrorMessage,
      barCode: queryBuilder.barCode,
      tradeAt: queryBuilder.tradeAt ? format(queryBuilder.tradeAt, DateFormatStr) : null,
      extraPinNo: queryBuilder.personalCode,
      expireDay: product.expireDay.toString(),
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
    const { orderDeliveryId, couponStatus } = getBody;

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

    const type = orderDelivery.orderProductMapping!.product.partnerCompany!.type;

    switch (type) {
      case "SSG": {
          switch (couponStatus) {
            case OrderDeliveryCouponStatus.USED:
            case OrderDeliveryCouponStatus.EXPIRED: {
              throw new BadRequestException('변경할 수 없는 핀 상태입니다.');
            }
            case OrderDeliveryCouponStatus.NOT_USED: {
              orderDelivery.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
              await this.orderDeliveryRepository.save(orderDelivery);
              break;
            }
            case OrderDeliveryCouponStatus.REFUND_CANCEL: {
              orderDelivery.couponStatus = OrderDeliveryCouponStatus.REFUND_CANCEL;
              await this.orderDeliveryRepository.save(orderDelivery);
            }
            case OrderDeliveryCouponStatus.CANCEL: {
              orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
              await this.orderDeliveryRepository.save(orderDelivery);
              break;
            }
            default: {
              throw new BadRequestException('지원하지 않는 핀 상태입니다.');
            }
          }
        break;
      }
      case "GIFT_SHOW":
      case "GS_M_BIZ":
      case "GIFTIEL":
      case "CULTURELAND":
      case "GALAXIA": {
        switch (couponStatus) {
          case OrderDeliveryCouponStatus.NOT_USED:
          case OrderDeliveryCouponStatus.USED:
          case OrderDeliveryCouponStatus.EXPIRED:
          case OrderDeliveryCouponStatus.REFUND_CANCEL: {
            throw new BadRequestException('변경할 수 없는 핀 상태입니다.');
          }
          case OrderDeliveryCouponStatus.CANCEL: {
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
            await this.partnerCompanyExternService.cancel(orderDelivery);
            await this.orderDeliveryRepository.save(orderDelivery);
            break;
          }
          default: {
            throw new BadRequestException('지원하지 않는 핀 상태입니다.');
          }
        }
      }
      default: {
        throw new BadRequestException('지원하지 않는 협력사입니다.');
      }
    }
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

  /**
   * order_history 등록
   * @param user 
   * @param getBody 
   */
  async execCreateHistory(map: Partial<OrderHistoryEntity>) {
    return await this.orderHistoryRepository.save(map);
  }
  
  /**
   * 핀상태변경 API 유효성검사
   * @param getBody 
   */
  async validPinStatusModify(getBody: CustomerServicePinStatusModifyReqDto) {
    if (isEmpty(getBody.orderDeliveryId)) throw new NotFoundException('데이터 정보가 없습니다.');
    if (isEmpty(getBody.afterChange)) throw new BadRequestException('변경 후 데이터가 없습니다.');
  }

  /**
   * 핀상태변경 API 데이터매핑
   * @param getBody 
   * @returns 
   */
  async mapPinStatusModify(@User() user: ILoginUserInfo, getBody: CustomerServicePinStatusModifyReqDto) {
    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: {
        id: getBody.orderDeliveryId,
        deletedAt: IsNull(),
      },
      relations: [
        'orderProductMapping',
        'orderProductMapping.product',
        'orderProductMapping.order',
        'orderHistory',
      ],
    });

    if (!orderDelivery) {
      throw new BadRequestException('데이터가 존재하지 않습니다.');
    }

    const result = {
      businessName: orderDelivery.orderProductMapping.product.partnerCompany?.businessName,
      beforeChange: orderDelivery.couponStatus,
      afterChange: getBody.afterChange,
      type: '핀상태 변경',
      content: '핀상태 변경',
      userId: user.id,
      orderDelivery,
    };

    return result;
  }

  /**
   * 핀상태변경 API 서비스실행
   * @param map 
   */
  async execPinStatusModify(map: any) {
    const { businessName, beforeChange, afterChange, type, content, orderDelivery } = map;

    switch (businessName) {
      case 'GS엠비즈':
      case '대홍기획':
      case '컬쳐랜드':
      case '갤럭시아':
      case '케이티알파':
        if (beforeChange === 'USED' || beforeChange === 'CANCEL' || beforeChange === 'EXPIRED') {
          throw new BadRequestException('현재 변경을 할 수 없는 핀상태입니다.');
        }
        
        if (afterChange === 'CANCEL' || afterChange === 'REFUND_CANCEL') {
          const result = this.partnerCompanyExternService.cancel(orderDelivery);

          if ((await result).message === '폐기 완료') {
            orderDelivery.status = IOrderDeliveryStatus.CANCEL;

            await this.orderDeliveryRepository.save(orderDelivery);

            const history = this.orderHistoryRepository.create({
              orderDeliveryId: orderDelivery.id,
              userId: map.userId,
              type: type,
              content: content,
              beforeChange: beforeChange,
              afterChange: IOrderDeliveryStatus.CANCEL,
            });

            await this.orderHistoryRepository.save(history);
          } else {
            throw new InternalServerErrorException((await result).message);
          }
        } else {
          throw new BadRequestException('변경을 할 수 없는 핀상태입니다.');
        }
        
        break;
      case 'SSG':
        if (beforeChange === 'USED' || beforeChange === 'EXPIRED') {
          throw new BadRequestException('현재 변경을 할 수 없는 핀상태입니다.');
        }

        if (afterChange === 'USED' || afterChange === 'REFUND_CANCEL') {
          orderDelivery.status = IOrderDeliveryStatus.CANCEL;

          await this.orderDeliveryRepository.save(orderDelivery);

          const history = this.orderHistoryRepository.create({
              orderDeliveryId: orderDelivery.id,
              userId: orderDelivery.userId,
              type: type,
              content: content,
              beforeChange: beforeChange,
              afterChange: IOrderDeliveryStatus.CANCEL,
            });

          await this.orderHistoryRepository.save(history);
        } else {
          throw new BadRequestException('변경을 할 수 없는 핀상태입니다.');
        }
        
        break;
      default :
        throw new BadRequestException('처리할 수 없는 협력사 입니다.');
    }
  }

  /**
   * 핀상태갱신 API 유효성검사
   * @param getBody 
   */
  async validPinStatusRefresh(getBody: CustomerServicePinStatusRefreshReqDto) {
    if (isEmpty(getBody.orderDeliveryId)) throw new NotFoundException('데이터 정보가 없습니다.');
  }

  /**
   * 핀상태갱신 API 데이터매핑
   * @param getBody 
   * @returns 
   */
  async mapPinStatusRefresh(@User() user: ILoginUserInfo, getBody: CustomerServicePinStatusRefreshReqDto) {
    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: {
        id: getBody.orderDeliveryId,
        deletedAt: IsNull(),
      },
      relations: [
        'orderProductMapping',
        'orderProductMapping.product',
        'orderProductMapping.order',
        'orderHistory',
      ],
    });

    if (!orderDelivery) {
      throw new BadRequestException('데이터가 존재하지 않습니다.');
    }

    const result = {
      userId: user.id,
      type: '핀상태 변경',
      content: '핀상태 변경',
      beforeChange: orderDelivery.couponStatus,
      orderDelivery,
    };

    return result;
  }

  /**
   * 핀상태갱신 API 서비스실행
   * @param map 
   */
  async execPinStatusRefresh(map: any) {
    await this.partnerCompanyExternService.refreshCouponStatus(map.orderDelivery);

    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: {
        id: map.orderDelivery.orderDeliveryId,
        deletedAt: IsNull(),
      },
      relations: [
        'orderProductMapping',
        'orderProductMapping.product',
        'orderProductMapping.order',
        'orderHistory',
      ],
    });

    let resCouponStatus = orderDelivery?.couponStatus;

    const history = this.orderHistoryRepository.create({
        orderDeliveryId: map.orderDelivery.id,
        userId: map.userId,
        type: map.type,
        content: map.content,
        beforeChange: map.beforeChange,
        afterChange: resCouponStatus,
      });

    await this.orderHistoryRepository.save(history);
  }

  /**
   * CS 등록 API 유효성검사
   * @param getBody 
   */
  async validStatus(getBody: CustomerServiceStatusReqDto) {
    if (isEmpty(getBody.orderDeliveryId)) throw new NotFoundException('데이터 정보가 없습니다.');
    if (isEmpty(getBody.type)) {
      throw new BadRequestException('CS 유형을 선택해 주세요.');
    } else if (getBody.type === '재전송' && isEmpty(getBody.extraType)) {
      throw new BadRequestException('재전송 유형을 선택해 주세요.');
    }
  }

  /**
   * CS 등록 API 데이터매핑
   * @param getBody 
   * @returns 
   */
  async mapStatus(@User() user: ILoginUserInfo, getBody: CustomerServiceStatusReqDto) {
    const orderDelivery = await this.orderDeliveryRepository.findOne({
      where: {
        id: getBody.orderDeliveryId,
        deletedAt: IsNull(),
      },
      relations: [
        'orderProductMapping',
        'orderProductMapping.product',
        'orderProductMapping.order',
        'orderHistory',
      ],
    });

    if (!orderDelivery) {
      throw new BadRequestException('데이터가 존재하지 않습니다.');
    }

    if (getBody.extraType === 'phone') {
      getBody.afterChange = getBody.afterChange?.replace(/[^0-9]/g, '').trim();
    }

    let beforeChange = '';
    switch (getBody.type) {
      case '수신정보 변경요청': {
        beforeChange = orderDelivery.deliveryTarget;
        break;
      }
      case '폐기':
      case '환불폐기': {
        beforeChange = orderDelivery.couponStatus;
        break;
      }
      default : {
        beforeChange = '';
      }
    }

    const result = {
      orderDeliveryId: getBody.orderDeliveryId,
      userId: user.id,
      type: getBody.type,
      extraType: getBody.extraType || '',
      content: getBody.content || '',
      beforeChange: beforeChange || '',
      afterChange: getBody.afterChange || '',
      orderDelivery,
    };

    return result;
  }

  /**
   * CS 등록 API 서비스실행
   * @param map 
   */
  async execStatus(map: any) {
    switch (map.type) {
      case '단순문의': {
        break;
      }
      case '재전송': {
        switch (map.extraType) {
          case 'sms': {
            // sms 재전송
            break;
          }
          case 'mms': {
            const resendDto = new CustomerServiceReSendReqDto();
            resendDto.orderDeliveryId = map.orderDeliveryId;

            await this.reSend(resendDto);
            break;
          }
          default : {
            throw new BadRequestException('지원하지 않는 재전송 유형입니다.');
          }
        }
        break;
      }
      case '수신정보 변경요청': {
        const orderDeliveryDto = new OrderDeliveryEntity();
        orderDeliveryDto.id = map.orderDeliveryId;
        orderDeliveryDto.deliveryMethod = map.afterChange;

        await this.orderDeliveryRepository.save(orderDeliveryDto);

        const resendDto = new CustomerServiceReSendReqDto();
        resendDto.orderDeliveryId = map.orderDeliveryId;

        await this.reSend(resendDto);
        break;
      }
      case '폐기':
      case '환불폐기': {
        const pinDiscardDto = new CustomerServiceDiscardReqDto();
        pinDiscardDto.orderDeliveryId = map.orderDeliveryId;
        pinDiscardDto.couponStatus = map.beforeChange;

        await this.pinDiscard(pinDiscardDto);
        break;
      }
      default : {
        throw new BadRequestException('지원하지 않는 유형입니다.');
      }
    }
    
    const history = this.orderHistoryRepository.create({
        orderDeliveryId: map.orderDelivery.id,
        userId: map.userId,
        type: map.type,
        content: map.content,
        beforeChange: map.beforeChange,
        afterChange: map.orderDelivery.status,
      });

    await this.orderHistoryRepository.save(history);
  }

  /**
   * 변경내역 상세 list 조회 API 유효성검사
   * @param getBody 
   */
  async validStatusList(getBody: CustomerServiceStatusListReqDto) {
    if (isEmpty(getBody.orderDeliveryId)) throw new NotFoundException('발송 상세 데이터 정보가 없습니다.');
  }

  /**
   * 변경내역 상세 list 조회 API 데이터매핑
   * @param getBody 
   * @returns 
   */
  async mapStatusList(getBody: CustomerServiceStatusListReqDto) {
    const result = {
      orderDeliveryId: getBody.orderDeliveryId,
      page: getBody.page,
      take: getBody.take,
    }
  }

  /**
   * 변경내역 상세 list 조회 API 서비스실행
   * @param map 
   */
  async execStatusList(map: any) {
    const { orderDeliveryId, page, take } = map;

    const skip = (page - 1) * take;

    const queryBuilder = this.dataSource
      .getRepository(OrderHistoryEntity)
      .createQueryBuilder('history')
      .leftJoinAndSelect('history.user', 'user')
      .where('history.orderDeliveryId = :orderDeliveryId', { orderDeliveryId })
      .orderBy('history.id', 'DESC')
      .skip(skip)
      .take(take);

    const [list, totalCount] = await queryBuilder.getManyAndCount();

    return {
      list: list.map((h: OrderHistoryEntity) => ({
        id: h.id,
        type: h.type,
        createdAt: h.createdAt,
        personName: h.user?.personName ?? '',
        content: h.content,
        beforeChange: h.beforeChange,
        afterChange: h.afterChange,
      })),
      totalCount,
      totalPage: Math.ceil(totalCount / take),
      currentPage: page,
    };
  }
}
