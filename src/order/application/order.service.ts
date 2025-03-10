import { BadRequestException, Injectable } from '@nestjs/common';
import {
  OrderCreateSettleReqDto,
  OrderCreateTempReqDto,
  OrderDeliveryCancelReqDto,
  OrderDeliveryConfirmedReqDto,
  OrderDeliveryRequestReqDto,
  OrderExcelDownloadReqQueryDto,
  OrderGetDetailReqParamDto,
  OrderGetListReqDto,
  OrderGetSettleReqDto,
  OrderUpdateOperationUserReqDto,
  OrderUpdateSettleReqDto,
  OrderUpdateTempReqDto,
} from '../api/order.req.dto';
import {
  OrderCreateTempResDto,
  OrderGetDetailResDto,
  OrderGetListResDto,
  OrderGetSettleGetListResDto,
} from '../api/order.res.dto';
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
import { join } from 'path';
import * as process from 'node:process';
import * as ExcelJS from 'exceljs';
import { OrderSettleViewDto } from '../api/dto/order.settle.view.dto';
import { UserDiscountEntity } from '../../entity/user.discount.entity';

@Injectable()
export class OrderService {
  // 기본 상단 이미지
  private static readonly DEFAULT_TOP_IMAGE_PATH =
    'https://epopkon-premium.s3.amazonaws.com/image/1740558623939-coupon-ttl.jpg';

  // 기본 중간 이미지
  private static readonly DEFAULT_MID_IMAGE_PATH =
    'https://epopkon-premium.s3.amazonaws.com/image/1740558757718-mms_text_img.jpg';

  constructor(
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderProductMappingEntity)
    private orderProductMappingRepository: Repository<OrderProductMappingEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(ProductEntity)
    private productRepository: Repository<ProductEntity>,
    @InjectRepository(UserDiscountEntity)
    private userDiscountRepository: Repository<UserDiscountEntity>,
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

    let topImagePath;
    let midImagePath;

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

        topImagePath = orderProductMapping.topImagePath ?? OrderService.DEFAULT_TOP_IMAGE_PATH;
        midImagePath = orderProductMapping.midImagePath ?? OrderService.DEFAULT_MID_IMAGE_PATH;

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
      topImagePath,
      midImagePath,
      status: order.status,
      productList: productList,
    };
  }

  async getOrderSettle(getQuery: OrderGetSettleReqDto): Promise<OrderGetSettleGetListResDto> {
    const { id, page, take } = getQuery;

    const skip = (page - 1) * take;

    const order = await this.orderRepository.findOne({
      where: {
        id,
      },
    });

    if (!order) {
      throw new BadRequestException('not found order');
    }

    // 1. 유저의 주문 상품 조회
    const [orderProductList, totalCount] = await this.orderProductMappingRepository.findAndCount({
      where: {
        orderId: id,
      },
      skip,
      take,
      relations: ['product', 'product.brand'],
    });

    const resultList: OrderSettleViewDto[] = await Promise.all(
      orderProductList.map(async (orderProduct) => {
        let priceAdjustment = orderProduct.priceAdjustment;
        let fee = orderProduct.fee;

        // 2. 할인 정보가 null 일 경우 유저 또는 협력사의 할인 옵션 조회
        if (!priceAdjustment || fee === null) {
          let discount = await this.userDiscountRepository.findOne({
            where: {
              userId: order.userId,
            },
          });

          // 3. 유저 할인 정보가 없으면 협력사 할인 정보 조회
          if (!discount) {
            discount = await this.userDiscountRepository.findOne({
              where: {
                partnerCompanyId: orderProduct.product.partnerCompanyId,
              },
            });
          }

          // 4. 할인 정보가 존재하면 null 값만 채우기
          if (discount) {
            priceAdjustment = priceAdjustment ?? discount.priceAdjustment;
            fee = fee ?? discount.pricePercent;
          }
        }

        return {
          id: orderProduct.id,
          brandName: orderProduct.product.brand?.nameKorean ?? null,
          name: orderProduct.product.name,
          price: orderProduct.product.price,
          amount: orderProduct.amount,
          totalPrice: orderProduct.product.price * orderProduct.amount,
          settleDiscountType: orderProduct.settleDiscountType ?? null,
          priceAdjustment,
          fee,
        };
      }),
    );

    const totalPage = Math.ceil(totalCount / take);

    return {
      list: resultList,
      currentPage: page,
      totalCount,
      totalPage,
    };
  }

  @Transactional()
  async createOrderSettle(getBody: OrderCreateSettleReqDto) {
    const { list } = getBody;

    if (list.length === 0) {
      return;
    }

    const orderProductIds = list.map((item) => item.id);

    const existingOrderProducts = await this.orderProductMappingRepository.find({
      where: { id: In(orderProductIds) },
    });

    const existingOrderProductMap = new Map(existingOrderProducts.map((order) => [order.id, order]));

    const missOrderProductIds = orderProductIds.filter((id) => !existingOrderProductMap.has(id));
    if (missOrderProductIds.length > 0) {
      throw new BadRequestException('존재하지 않는 주문 내역이 있습니다');
    }

    const orderProductList = list.map((settle) => {
      return this.orderProductMappingRepository.create({
        id: settle.id,
        settleDiscountType: settle.settleDiscountType,
        priceAdjustment: settle.priceAdjustment,
        fee: settle.fee,
      });
    });

    await this.orderProductMappingRepository.save(orderProductList);
  }

  @Transactional()
  async updateOrderSettle(getBody: OrderUpdateSettleReqDto) {
    const { list } = getBody;

    if (list.length === 0) {
      return;
    }

    const orderProductIds = list.map((item) => item.id);

    const existingOrderProducts = await this.orderProductMappingRepository.find({
      where: { id: In(orderProductIds) },
    });

    const existingOrderProductMap = new Map(existingOrderProducts.map((order) => [order.id, order]));

    const missOrderProductIds = orderProductIds.filter((id) => !existingOrderProductMap.has(id));
    if (missOrderProductIds.length > 0) {
      throw new BadRequestException('존재하지 않는 주문 내역이 있습니다');
    }

    const orderProductList = list.map((settle) => {
      // 이미 db에 있는 id 들을 create 에 넣으면 type orm 에서 update 로 동작한다
      return this.orderProductMappingRepository.create({
        id: settle.id,
        settleDiscountType: settle.settleDiscountType,
        priceAdjustment: settle.priceAdjustment,
        fee: settle.fee,
      });
    });

    await this.orderProductMappingRepository.save(orderProductList);
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
      topImagePath,
      midImagePath,
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
      orderProduct.topImagePath = topImagePath ?? OrderService.DEFAULT_TOP_IMAGE_PATH;
      orderProduct.midImagePath = midImagePath ?? OrderService.DEFAULT_MID_IMAGE_PATH;

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
      topImagePath,
      midImagePath,
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

    if (order.status !== IOrderStatus.TEMP) {
      throw new BadRequestException('임시저장이 아닐경우 수정할 수 없습니다.');
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
      if (!topImagePath) {
        orderProduct.topImagePath = OrderService.DEFAULT_TOP_IMAGE_PATH;
      }
      if (!midImagePath) {
        orderProduct.midImagePath = OrderService.DEFAULT_MID_IMAGE_PATH;
      }

      if (topImagePath !== undefined && topImagePath !== null) orderProduct.topImagePath = topImagePath;
      if (midImagePath !== undefined && midImagePath !== null) orderProduct.midImagePath = midImagePath;

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
      // .andWhere('order.userId = :userId', { userId: user.id })
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
          const { path } = await DeliveryCreateCouponImage(
            orderDelivery.orderProductMapping.product.imagePath,
            orderDelivery.orderProductMapping.product.name,
            orderDelivery.barCode,
            orderDelivery.orderProductMapping.product.brand!.nameKorean,
            orderDelivery.orderProductMapping.product.expireDay,
            orderDelivery.orderProductMapping.topImagePath,
            orderDelivery.orderProductMapping.midImagePath,
          );
          orderDelivery.imagePath = path;
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
      // .andWhere('order.userId = :userId', { userId: user.id })
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

  async excelDownload(user: ILoginUserInfo, getQuery: OrderExcelDownloadReqQueryDto) {
    const { eventName, type, status, userId, startAt, endAt, section } = getQuery;

    const now = new Date();
    const nowString = format(now, 'yyyyMMdd');
    let orderType = '';

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
      orderType = '주문';
    }

    // 발송관리 일 경우
    if (section === IOrderSection.SHIPPING) {
      if (user.authority === IUserAuthority.CORPORATE_ADMIN) {
        queryBuilder = queryBuilder.andWhere('order.userId = :userId', { userId: user.id });
      }

      if (user.authority === IUserAuthority.OPERATION_ADMIN) {
        queryBuilder = queryBuilder.andWhere('order.operationUserId = :userId', { userId: user.id });
      }

      orderType = '발송';
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

    const orderList = await queryBuilder.getMany();

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(`sheet1`);

    sheet.columns = [
      { header: '번호', key: 'id', width: 10 },
      { header: '등록일', key: 'createdAt', width: 32 },
      { header: '고객사', key: 'userBusinessName', width: 20 },
      { header: '담당자', key: 'userPersonName', width: 20 },
      { header: '이벤트명', key: 'eventName', width: 20 },
      { header: '상품명', key: 'productName', width: 32 },
      { header: '발송수량', key: 'totalProductCount', width: 32 },
      { header: '발송금액', key: 'expireDay', width: 32 },
      { header: '정산금액', key: 'category', width: 40 },
      { header: '진행상태', key: 'type', width: 40 },
      { header: '발송시간', key: 'useStatus', width: 40 },
    ];

    for (const order of orderList) {
      const sendRequestAt = normalizeDate(order.sendRequestAt) ? format(order.sendRequestAt, DateFormatStr) : null;

      let totalAmount = 0;
      let productName = '';
      if (order.orderProductMappings && order.orderProductMappings.length > 0) {
        totalAmount = order.orderProductMappings.reduce((acc, cur) => {
          return acc + cur.amount;
        }, 0);
        productName = order.orderProductMappings[0].product.name;
        const orderProductMappingsLength = order.orderProductMappings.length;
        if (orderProductMappingsLength - 1 > 0) {
          productName += `외 ${orderProductMappingsLength - 1}건`;
        }
      }

      sheet.addRow({
        id: order.id,
        registerAt: format(order.registerAt, DateFormatStr),
        userBusinessName: order.user!.businessName,
        userPersonName: order.user!.personName,
        eventName: order.eventName,
        productName: productName,
        totalAmount: totalAmount,
        deliveryPrice: 0, //TODO 발송 금액
        settlePrice: 0, // TODO 정산 금액
        status: order.status,
        sendRequestAt: sendRequestAt,
      });
    }

    const fileName = `${orderType}_리스트_${nowString}.xlsx`;
    const filePath = join(process.cwd(), '.', 'public', fileName);

    await workbook.xlsx.writeFile(filePath);

    return { fileName, filePath };
  }
}
