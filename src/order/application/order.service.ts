import { BadRequestException, Injectable } from '@nestjs/common';
import {
  OrderCreateTempReqDto,
  OrderDeliveryCancelReqDto,
  OrderDeliveryConfirmedReqDto,
  OrderDeliveryRequestReqDto,
  OrderGetDetailReqParamDto,
  OrderGetListReqDto,
  OrderUpdateOperationUserReqDto,
  OrderUpdateTempReqDto,
} from '../api/order.req.dto';
import { OrderCreateTempResDto, OrderGetDetailResDto, OrderGetListResDto } from '../api/order.res.dto';
import { OrderEntity } from '../../entity/order.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import { OrderViewDto } from '../api/dto/order.view.dto';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { IOrderStatus } from '../interface/order.status';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { Transactional } from 'typeorm-transactional';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { ProductEntity } from '../../entity/product.entity';
import { OrderValidation } from '../domain/order.validation';
import { listToMap } from '../../util/map.util';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { CreateTransactionId } from '../domain/create.transaction.id';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { DeliveryCreateCouponImage } from '../../delivery/infra/delivery.create.coupon.image';
import { UserEntity } from '../../entity/user.entity';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IOrderSection } from '../interface/order.section';
import { OrderDetailProductDto, OrderViewDeliveryDto } from '../api/dto/order.detail.product.dto';
import { normalizeDate } from '../../util/time.util';

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderProductMappingEntity)
    private orderProductMappingRepository: Repository<OrderProductMappingEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(ProductEntity)
    private productRepository: Repository<ProductEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private partnerCompanyExternService: PartnerCompanyExternService,
  ) {}

  async getList(user: ILoginUserInfo, getQuery: OrderGetListReqDto): Promise<OrderGetListResDto> {
    const { section, type, status, userId, startAt, endAt, eventName, page, take } = getQuery;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .where('order.type = :type', { type });

    // 주문 관리 일 경우
    if (section === IOrderSection.ORDER) {
      queryBuilder = queryBuilder.andWhere('order.userId = :userId', { userId: user.id });
    }

    // 발송관리 일 경우
    if (section === IOrderSection.SHIPPING) {
      if (user.authority === IUserAuthority.CORPORATE_ADMIN) {
        queryBuilder = queryBuilder.andWhere('order.userId = :userId', { userId: user.id });
      }

      if (user.authority === IUserAuthority.OPERATION_ADMIN) {
        queryBuilder = queryBuilder.andWhere('order.operationUserId = :userId', { userId: user.id });
      }
    }

    if (status) {
      queryBuilder = queryBuilder.andWhere('order.status = :status', { status });
    }

    if (userId) {
      queryBuilder = queryBuilder.andWhere('order.userId = :userId', { userId });
    }

    if (eventName) {
      queryBuilder = queryBuilder.andWhere('order.eventName = :eventName', { eventName: `%${eventName}%` });
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'order', 'sendRequestAt', startAt, endAt);

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.take(take).skip(skip);
    const [orderList, totalCount] = await queryBuilder.getManyAndCount();
    const totalPage = Math.ceil(totalCount / take);

    const resultList: OrderViewDto[] = orderList.map((order) => {
      let totalAmount = 0;
      let totalProductCount = 0;
      let productName = '';
      if (order.orderProductMappings && order.orderProductMappings.length > 0) {
        totalAmount = order.orderProductMappings.reduce((acc, cur) => {
          return acc + cur.amount;
        }, 0);
        totalProductCount = order.orderProductMappings.length;
        productName = order.orderProductMappings[0].product.name;
        const orderProductMappingsLength = order.orderProductMappings.length;
        if (orderProductMappingsLength - 1 > 0) {
          productName += `외 ${orderProductMappingsLength - 1}건`;
        }
      }

      const sendRequestAt = normalizeDate(order.sendRequestAt) ? format(order.sendRequestAt, DateFormatStr) : null;

      return {
        id: order.id,
        registerAt: format(order.registerAt, DateFormatStr),
        userBusinessName: order.user!.businessName,
        userPersonName: order.user!.personName,
        eventName: order.eventName,
        productName: productName,
        totalProductCount: totalProductCount,
        totalAmount: totalAmount,
        status: order.status,
        sendRequestAt: sendRequestAt,
        operationUserId: order.operationUserId,
        operationUserName: order.operationUser?.personName ?? null,
        deliveryPrice: 0, //TODO 발송금액
        settlePrice: 0, // TODO 정산 금액
      };
    });

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  async getDetail(getParam: OrderGetDetailReqParamDto): Promise<OrderGetDetailResDto> {
    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id = :id', { id: getParam.id });

    const order = await queryBuilder.getOne();

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    const productList: OrderDetailProductDto[] = [];

    if (order.orderProductMappings && order.orderProductMappings.length > 0) {
      for (const orderProductMapping of order.orderProductMappings) {
        const orderDeliveryList: OrderViewDeliveryDto[] = [];

        for (const orderDelivery of orderProductMapping.orderDeliveries) {
          orderDeliveryList.push({
            id: orderDelivery.id,
            deliveryTarget: orderDelivery.deliveryTarget,
            replaceCharacter1: orderDelivery.replaceCharacter1,
            replaceCharacter2: orderDelivery.replaceCharacter2,
            replaceCharacter3: orderDelivery.replaceCharacter3,
          });
        }

        const product = orderProductMapping.product
          ? {
              id: orderProductMapping.product.id,
              name: orderProductMapping.product.name,
              price: orderProductMapping.product.price,
              expireDay: orderProductMapping.product.expireDay,
              imagePath: orderProductMapping.product.imagePath,
              brandId: orderProductMapping.product.brandId,
              brandName: orderProductMapping.product.brand?.nameKorean ?? '',
            }
          : null;
        productList.push({
          id: orderProductMapping.id,
          product: product,
          orderDeliveryList: orderDeliveryList,
        });
      }
    }

    const sendRequestAt = normalizeDate(order.sendRequestAt) ? format(order.sendRequestAt, DateFormatStr) : null;

    return {
      id: order.id,
      registerAt: format(order.registerAt, DateFormatStr),
      eventName: order.eventName,
      type: order.type,
      sendMethod: order.sendMethod,
      sendTailText: order.sendTailText,
      requestToDestroyPersonalInfoDay: order.requestToDestroyPersonalInfoDay,
      fromPhoneNumber: order.fromPhoneNumber,
      sendTitle: order.sendTitle,
      sendContent: order.sendContent,
      sendRequestAt: sendRequestAt,
      status: order.status,
      productList: productList,
    };
  }

  @Transactional()
  async createTemp(user: ILoginUserInfo, getBody: OrderCreateTempReqDto): Promise<OrderCreateTempResDto> {
    const {
      type,
      eventName,
      sendMethod,
      sendTailText,
      requestToDestroyPersonalInfoDay,
      fromPhoneNumber,
      sendTitle,
      sendContent,
      sendRequestAt,
      orderProductList,
    } = getBody;

    const productIdList = orderProductList.map((product) => product.productId);
    const uniqueProductId = new Set(productIdList);

    if (uniqueProductId.size !== productIdList.length) {
      throw new BadRequestException('중복 상품이 존재합니다.');
    }

    const getProductList = await this.productRepository.find({
      where: {
        id: In(productIdList),
      },
    });

    if (productIdList.length !== getProductList.length) {
      throw new BadRequestException('존재하지 않는 상품을 추가하였습니다.');
    }
    const productPriceMap = listToMap(getProductList, (product) => product.id);

    // 전송 정산 가격 적용
    let sendAmount = 0;

    for (const orderProduct of orderProductList) {
      const getProduct = productPriceMap.get(orderProduct.productId)!;
      sendAmount += getProduct.price * orderProduct.amount;
    }

    const orderInsertResult = await this.orderRepository.insert({
      userId: user.id,
      status: IOrderStatus.TEMP,
      type,
      eventName,
      sendMethod,
      sendTailText,
      requestToDestroyPersonalInfoDay,
      fromPhoneNumber,
      sendTitle,
      sendContent,
      sendAmount: sendAmount,
      settleAmount: sendAmount, // TODO 정산 할인 가격 적용 필요
      registerAt: new Date(),
      sendRequestAt: new Date(sendRequestAt),
    });
    const orderId: number = orderInsertResult.identifiers[0].id;

    const orderDeliveryCreateList: OrderDeliveryEntity[] = [];

    for (const product of orderProductList) {
      const orderProduct = new OrderProductMappingEntity();

      orderProduct.orderId = orderId;
      orderProduct.productId = product.productId;
      orderProduct.amount = product.amount;

      await this.orderProductMappingRepository.save(orderProduct);
      for (const orderDelivery of product.orderDeliveryList) {
        const oneOrderDelivery = new OrderDeliveryEntity();
        oneOrderDelivery.orderProductMappingId = orderProduct.id;
        oneOrderDelivery.status = IOrderDeliveryStatus.TEMP;
        oneOrderDelivery.deliveryMethod = sendMethod;
        oneOrderDelivery.deliveryTarget = orderDelivery.deliveryTarget;
        oneOrderDelivery.replaceCharacter1 = orderDelivery.replaceCharacter1 ?? null;
        oneOrderDelivery.replaceCharacter2 = orderDelivery.replaceCharacter2 ?? null;
        oneOrderDelivery.replaceCharacter3 = orderDelivery.replaceCharacter3 ?? null;
        oneOrderDelivery.sendRequestAt = new Date(sendRequestAt);
        orderDeliveryCreateList.push(oneOrderDelivery);
      }
    }

    await this.orderDeliveryRepository.insert(orderDeliveryCreateList);

    return { id: orderId };
  }

  @Transactional()
  async updateTemp(user: ILoginUserInfo, getBody: OrderUpdateTempReqDto): Promise<void> {
    const {
      id,
      eventName,
      sendMethod,
      sendTailText,
      requestToDestroyPersonalInfoDay,
      fromPhoneNumber,
      sendTitle,
      sendContent,
      sendRequestAt,
      orderProductList,
    } = getBody;

    const order = await this.orderRepository.findOne({
      where: {
        id: id,
        userId: user.id,
        // status: IOrderStatus.TEMP,
      },
    });

    if (!order) {
      throw new BadRequestException('존재하지 않는 주문입니다.');
    }

    const productIdList = orderProductList.map((orderProduct) => orderProduct.productId);
    const uniqueProductId = new Set(productIdList);

    if (uniqueProductId.size !== productIdList.length) {
      throw new BadRequestException('중복 상품이 존재합니다.');
    }

    const getProductList = await this.productRepository.find({
      where: {
        id: In(productIdList),
      },
    });

    if (productIdList.length !== getProductList.length) {
      throw new BadRequestException('존재하지 않는 상품을 추가하였습니다.');
    }
    const productPriceMap = listToMap(getProductList, (product) => product.id);

    // 전송 정산 가격 적용
    let sendAmount = 0;
    for (const orderProduct of orderProductList) {
      const getProduct = productPriceMap.get(orderProduct.productId)!;
      sendAmount += getProduct.price * orderProduct.amount;
    }

    order.eventName = eventName;
    order.sendMethod = sendMethod;
    order.sendTailText = sendTailText;
    order.requestToDestroyPersonalInfoDay = requestToDestroyPersonalInfoDay;
    order.fromPhoneNumber = fromPhoneNumber;
    order.sendTitle = sendTitle;
    order.sendContent = sendContent;
    order.sendAmount = sendAmount; // TODO 정산 할인 가격 적용 필요
    order.sendRequestAt = new Date(sendRequestAt);

    await this.orderRepository.save(order);

    const orderId: number = order.id;

    // 2. 기존 order product, delivery 삭제
    const deleteOrderProductMappingList = await this.orderProductMappingRepository.find({
      where: {
        orderId: orderId,
      },
    });
    const deleteOrderProductIdList = deleteOrderProductMappingList.map((orderProduct) => orderProduct.id);
    await this.orderProductMappingRepository.delete({ id: In(deleteOrderProductIdList) });
    await this.orderDeliveryRepository.delete({ orderProductMappingId: In(deleteOrderProductIdList) });

    // 3. 신규 order delivery, product 생성
    const orderDeliveryCreateList: OrderDeliveryEntity[] = [];

    for (const product of orderProductList) {
      const orderProduct = new OrderProductMappingEntity();

      orderProduct.orderId = orderId;
      orderProduct.productId = product.productId;
      orderProduct.amount = product.amount;

      await this.orderProductMappingRepository.save(orderProduct);
      for (const orderDelivery of product.orderDeliveryList) {
        const oneOrderDelivery = new OrderDeliveryEntity();
        oneOrderDelivery.orderProductMappingId = orderProduct.id;
        oneOrderDelivery.status = IOrderDeliveryStatus.TEMP;
        oneOrderDelivery.deliveryMethod = sendMethod;
        oneOrderDelivery.deliveryTarget = orderDelivery.deliveryTarget;
        oneOrderDelivery.replaceCharacter1 = orderDelivery.replaceCharacter1 ?? null;
        oneOrderDelivery.replaceCharacter2 = orderDelivery.replaceCharacter2 ?? null;
        oneOrderDelivery.replaceCharacter3 = orderDelivery.replaceCharacter3 ?? null;
        oneOrderDelivery.sendRequestAt = new Date(sendRequestAt);
        orderDeliveryCreateList.push(oneOrderDelivery);
      }
    }

    await this.orderDeliveryRepository.insert(orderDeliveryCreateList);

    return;
  }

  @Transactional()
  async deliveryRequest(user: ILoginUserInfo, getBody: OrderDeliveryRequestReqDto): Promise<void> {
    const { id } = getBody;

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id = :id', { id })
      .andWhere('order.userId = :userId', { userId: user.id })
      .getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않습니다.');
    }

    OrderValidation(order);
    for (const orderMapping of order.orderProductMappings!) {
      for (const orderDelivery of orderMapping.orderDeliveries) {
        orderDelivery.transactionId = CreateTransactionId(order.id, orderDelivery.id);
        await this.orderDeliveryRepository.save(orderDelivery);
      }
    }

    order.status = IOrderStatus.DELIVERY_REQUEST;
    await this.orderRepository.save(order);

    return;
  }

  @Transactional()
  async deliveryConfirmed(user: ILoginUserInfo, getBody: OrderDeliveryConfirmedReqDto) {
    const { id } = getBody;

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .innerJoinAndSelect('orderDeliveries.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .where('order.id = :id', { id })
      .andWhere('order.userId = :userId', { userId: user.id })
      .andWhere('order.status = :status', { status: IOrderStatus.DELIVERY_REQUEST })
      .getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않습니다.');
    }

    OrderValidation(order);

    for (const orderMapping of order.orderProductMappings!) {
      for (const orderDelivery of orderMapping.orderDeliveries) {
        await this.partnerCompanyExternService.issue(orderDelivery);
        orderDelivery.status = IOrderDeliveryStatus.WAIT;
        if (orderDelivery.barCode) {
          const { fileName } = await DeliveryCreateCouponImage(
            orderDelivery.orderProductMapping.product.imagePath,
            orderDelivery.orderProductMapping.product.name,
            orderDelivery.barCode,
            orderDelivery.orderProductMapping.product.brand!.nameKorean,
            orderDelivery.orderProductMapping.product.expireDay,
          );
          orderDelivery.imagePath = fileName;
        }

        await this.orderDeliveryRepository.save(orderDelivery);
      }
    }

    order.status = IOrderStatus.DELIVERY_CONFIRMED;
    await this.orderRepository.save(order);

    return;
  }

  @Transactional()
  async deliveryCancel(user: ILoginUserInfo, getBody: OrderDeliveryCancelReqDto) {
    const { id } = getBody;

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .where('order.id = :id', { id })
      .andWhere('order.userId = :userId', { userId: user.id })
      .andWhere('order.status = :status', { status: 'DELIVERY_REQUEST' })
      .getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않습니다.');
    }

    const orderProductMappingIdList = order.orderProductMappings!.map((orderProductMapping) => orderProductMapping.id);

    order.status = IOrderStatus.DELIVERY_CANCEL;
    await this.orderRepository.save(order);
    await this.orderDeliveryRepository.update(
      { orderProductMappingId: In(orderProductMappingIdList) },
      { status: IOrderDeliveryStatus.CANCEL },
    );

    return;
  }

  async updateOperationUser(getBody: OrderUpdateOperationUserReqDto) {
    const { id, operationUserId } = getBody;

    const order = await this.orderRepository.createQueryBuilder('order').where('order.id = :id', { id }).getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않습니다.');
    }

    const operationUser = await this.userRepository.findOne({
      where: {
        id: operationUserId,
      },
    });

    if (!operationUser) {
      throw new BadRequestException('존재하지 않는 유저입니다.');
    }

    if (operationUser.authority !== IUserAuthority.OPERATION_ADMIN) {
      throw new BadRequestException('운영 담당자 유저가 아닙니다.');
    }

    order.operationUserId = operationUserId;

    await this.orderRepository.save(order);
    return;
  }
}
