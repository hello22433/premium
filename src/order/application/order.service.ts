import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import {
  OrderCreateSettleReqDto,
  OrderCreateTempReqDto,
  OrderDeliveryCancelReqDto,
  OrderDeliveryConfirmedReqDto,
  OrderDeliveryRequestReqDto,
  OrderDeliverySsgCouponExpireChangeReqDto,
  OrderExcelDownloadReqBodyDto,
  OrderGetDeliveryCompleteReportPdfReqDto,
  OrderGetDeliveryCompleteReportReqDto,
  OrderGetDetailReqParamDto,
  OrderGetListReqDto,
  OrderGetOrderCompleteReportPdfReqDto,
  OrderGetOrderCompleteReportReqDto,
  OrderGetSettleReqDto,
  OrderUpdateOperationUserReqDto,
  OrderUpdateSettleReqDto,
  OrderUpdateTempReqDto,
} from '../api/order.req.dto';
import {
  OrderCreateTempResDto,
  OrderDeliveryConfirmed,
  OrderGetDeliveryCompleteReportResDto,
  OrderGetDetailResDto,
  OrderGetListResDto,
  OrderGetMyOrderHistoryResDto,
  OrderGetOrderCompleteReportResDto,
  OrderGetSettleGetListResDto,
} from '../api/order.res.dto';
import { OrderEntity } from '../../entity/order.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Like, MoreThanOrEqual, Repository } from 'typeorm';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import { OrderViewDto } from '../api/dto/order.view.dto';
import { DateDateFormatStr, DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { IOrderStatus } from '../interface/order.status';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { Transactional } from 'typeorm-transactional';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { ProductEntity } from '../../entity/product.entity';
import { OrderValidation } from '../domain/order.validation';
import { listToMap, listToMapValue } from '../../util/map.util';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { CreateTransactionId } from '../domain/create.transaction.id';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { DeliveryCreateCouponImage } from '../../delivery/infra/delivery.create.coupon.image';
import { UserEntity } from '../../entity/user.entity';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IOrderSection } from '../interface/order.section';
import {
  OrderCompleteReportDeliveryViewDto,
  OrderDeliveryCompleteReportViewDto,
  OrderDetailProductDto,
  OrderPdfDetailProductDto,
  OrderViewDeliveryDto,
} from '../api/dto/order.detail.product.dto';
import { normalizeDate } from '../../util/time.util';
import { join } from 'path';
import * as process from 'node:process';
import * as ExcelJS from 'exceljs';
import { OrderSettleViewDto } from '../api/dto/order.settle.view.dto';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { IOrderType } from '../interface/order.type';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { SsgEventAmountHistoryEntity } from '../../entity/ssg.event.amount.history.entity';
import { IProductType } from '../../product/interface/product.type';
import { defaultOrderMidImagePath, defaultOrderTopImagePath } from '../../const';
import { OrderStatusExcelMapping } from '../domain/order.excel.mapping';
import { OrderFeeCalculator } from '../domain/order.fee.calculator';
import { OrderCustomerViewDto } from '../api/dto/order.customer.view.dto';
import { maskBarCode } from '../../util/mask.barcode.util';
import { CreateCode } from '../../common/domain/create.code';
import { OrderDigitNumber, OrderPrefixCode } from '../domain/order.code';

@Injectable()
export class OrderService {
  // 기본 상단 이미지
  private static readonly DEFAULT_TOP_IMAGE_PATH = defaultOrderTopImagePath;

  // 기본 중간 이미지
  private static readonly DEFAULT_MID_IMAGE_PATH = defaultOrderMidImagePath;

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
    @InjectRepository(SsgEventEntity)
    private ssgEventRepository: Repository<SsgEventEntity>,
    @InjectRepository(SsgEventAmountHistoryEntity)
    private ssgEventAmountHistoryRepository: Repository<SsgEventAmountHistoryEntity>,
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
      if (user.authority !== IUserAuthority.SUPER_ADMIN) {
        queryBuilder = queryBuilder.andWhere('order.userId = :userId', { userId: user.id });
      }
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

    queryBuilder = queryBuilder.orderBy('order.id', 'DESC');

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
        deliveryPrice: order.sendAmount,
        settlePrice: order.settleAmount,
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
              amount: orderProductMapping.amount,
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

    let couponExpiration: number | null = null;
    if (order.type === IOrderType.SSG) {
      couponExpiration = productList[0].product?.expireDay ?? null;
    }

    return {
      id: order.id,
      registerAt: format(order.registerAt, DateFormatStr),
      eventName: order.eventName,
      type: order.type,
      sendMethod: order.sendMethod,
      sendTailText: order.sendTailText,
      requestToDestroyPersonalInfoDay: order.requestToDestroyPersonalInfoDay,
      fromPhoneNumber: order.fromPhoneNumber,
      fromEmail: order.fromEmail,
      emailSendType: order.emailSendType,
      useEmailContent: order.useEmailContent,
      sendTitle: order.sendTitle,
      sendContent: order.sendContent,
      sendRequestAt: sendRequestAt,
      topImagePath,
      midImagePath,
      status: order.status,
      couponExpiration: couponExpiration,
      productList: productList,
    };
  }

  async getDeliveryCompleteReport(
    getQuery: OrderGetDeliveryCompleteReportReqDto,
  ): Promise<OrderGetDeliveryCompleteReportResDto> {
    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id = :id', { id: getQuery.id });

    const order = await queryBuilder.getOne();

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    if (order.status !== IOrderStatus.DELIVERY_COMPLETE) {
      throw new BadRequestException('발송 완료된 건에 대해서만 조회 가능합니다.');
    }

    const productList: OrderPdfDetailProductDto[] = [];
    const userInfo: OrderCustomerViewDto = {
      id: order.user?.id ?? null,
      userBusinessName: order.user?.businessName ?? null,
      userPersonPhoneNumber: order.user?.personPhoneNumber ?? null,
      userBusinessEmail: order.user?.email ?? null,
      userPersonName: order.user?.personName ?? null,
    };
    const now = new Date();
    const today = format(now, 'yyMMdd');
    const fileName: string = `${order.user?.businessName}_발송완료리포트_${today}`;

    if (order.orderProductMappings && order.orderProductMappings.length > 0) {
      for (const orderProductMapping of order.orderProductMappings) {
        const orderDeliveryList: OrderDeliveryCompleteReportViewDto[] = [];

        for (const orderDelivery of orderProductMapping.orderDeliveries) {
          orderDeliveryList.push({
            id: orderDelivery.id,
            sendRequestAt: orderDelivery.sendRequestAt ? format(orderDelivery.sendRequestAt, DateFormatStr) : null,
            productName: orderProductMapping.product.name ?? null,
            amount: orderProductMapping.product.price ?? null,
            barCode: orderDelivery.barCode ? maskBarCode(orderDelivery.barCode) : null,
            deliveryTarget: maskBarCode(orderDelivery.deliveryTarget),
          });
        }

        const product = orderProductMapping.product
          ? {
              id: orderProductMapping.product.id,
              name: orderProductMapping.product.name,
              price: orderProductMapping.product.price,
              expireDay: orderProductMapping.product.expireDay,
              amount: orderProductMapping.amount,
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

    let couponExpiration: number | null = null;
    if (order.type === IOrderType.SSG) {
      couponExpiration = productList[0].product?.expireDay ?? null;
    }

    return {
      id: order.id,
      fileName,
      userInfo,
      registerAt: format(order.registerAt, DateFormatStr),
      eventName: order.eventName,
      type: order.type,
      sendMethod: order.sendMethod,
      fromPhoneNumber: order.fromPhoneNumber,
      fromEmail: order.fromEmail,
      sendTitle: order.sendTitle,
      sendContent: order.sendContent,
      sendRequestAt: sendRequestAt,
      status: order.status,
      couponExpiration: couponExpiration,
      productList: productList,
    };
  }

  async deliveryCompleteReportPdf(getBody: OrderGetDeliveryCompleteReportPdfReqDto): Promise<void> {
    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id = :id', { id: getBody.id });

    const order = await queryBuilder.getOne();

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    order.deliveryCompleteReportCount++;

    await this.orderRepository.save(order);

    return;
  }

  async getOrderCompleteReport(
    getQuery: OrderGetOrderCompleteReportReqDto,
  ): Promise<OrderGetOrderCompleteReportResDto> {
    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id = :id', { id: getQuery.id });

    const order = await queryBuilder.getOne();

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    if (order.status !== IOrderStatus.DELIVERY_COMPLETE) {
      throw new BadRequestException('발송 완료된 건에 대해서만 조회 가능합니다.');
    }

    const serialNumber: string = `${format(order.createdAt, DateDateFormatStr)}-${order.id}`;
    const fileName: string = `${serialNumber}_거래명세서`;
    const orderDeliveryList: OrderCompleteReportDeliveryViewDto[] = [];

    let price = 0;
    let vat = 0;
    let totalAmount = 0;

    if (order.orderProductMappings && order.orderProductMappings.length > 0) {
      for (const orderProductMapping of order.orderProductMappings) {
        const productPrice = orderProductMapping.product.price ?? 0;
        const quantity = orderProductMapping.amount ?? 0;
        const total = productPrice * quantity;
        price += total;

        for (const orderDelivery of orderProductMapping.orderDeliveries) {
          orderDeliveryList.push({
            id: orderDelivery.id,
            sendRequestAt: orderDelivery.sendRequestAt ? format(orderDelivery.sendRequestAt, DateFormatStr) : null,
            productName: orderProductMapping.product.name ?? null,
            quantity,
            vat: Math.floor(productPrice / 10),
            price: productPrice,
          });
        }
      }

      vat = Math.floor(price * 0.1);
      totalAmount = price + vat;
    }

    const sendRequestAt = normalizeDate(order.sendRequestAt) ? format(order.sendRequestAt, DateFormatStr) : null;

    return {
      fileName,
      serialNumber,
      userSettleCondition: order.user!.settleCondition,
      businessName: order.user!.businessName,
      businessNumber: order.user!.businessNumber,
      personName: order.user!.personName,
      businessAddress: order.user?.businessAddress ?? null,
      businessType: null, // TODO
      businessItem: null, // TODO
      eventName: order.eventName,
      sendRequestAt: sendRequestAt ?? null,
      price,
      vat,
      totalAmount,
      orderDeliveryList,
    };
  }

  async orderCompleteReportPdf(getBody: OrderGetOrderCompleteReportPdfReqDto): Promise<void> {
    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id = :id', { id: getBody.id });

    const order = await queryBuilder.getOne();

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    order.orderCompleteReportCount++;

    await this.orderRepository.save(order);

    return;
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

        let discountPrice = orderProduct.product.price;
        const totalPrice = orderProduct.product.price * orderProduct.amount;
        let discountTotalPrice = orderProduct.product.price * orderProduct.amount;

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
          fee = fee ?? 0;
        }

        if (fee === null || (fee < 1 && fee > 0) || fee < 0 || fee > 100) {
          throw new InternalServerErrorException('수수료는 1~100 이여야 합니다.');
        }

        discountPrice = OrderFeeCalculator({
          fee: fee!,
          priceAdjustment: priceAdjustment!,
          price: orderProduct.product.price,
        });
        discountTotalPrice = OrderFeeCalculator({
          fee: fee!,
          priceAdjustment: priceAdjustment!,
          price: totalPrice,
        });

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
          discountPrice,
          discountTotalPrice,
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

    const existingOrderProducts = await this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .where('orderProductMapping.id IN (:...orderProductIds)', { orderProductIds })
      .getMany();

    const existingOrderProductMap = new Map(existingOrderProducts.map((order) => [order.id, order]));

    const missOrderProductIds = orderProductIds.filter((id) => !existingOrderProductMap.has(id));
    if (missOrderProductIds.length > 0) {
      throw new BadRequestException('존재하지 않는 주문 내역이 있습니다');
    }

    const orderId = existingOrderProducts[0].orderId;
    const settleAmount = existingOrderProducts[0].order.sendAmount;
    let settleFee = 0;

    const orderProductList = list.map((settle) => {
      const oneOrderProduct = existingOrderProductMap.get(settle.id);
      if (!oneOrderProduct) {
        throw new InternalServerErrorException('not exist order product');
      }
      if (settle.priceAdjustment === 'DISCOUNT') {
        settleFee -= (oneOrderProduct.product.price * (settle.fee ?? 0)) / 100;
      }

      if (settle.priceAdjustment === 'ADDITIONAL') {
        settleFee += (oneOrderProduct.product.price * (settle.fee ?? 0)) / 100;
      }

      return this.orderProductMappingRepository.create({
        id: settle.id,
        settleDiscountType: settle.settleDiscountType,
        priceAdjustment: settle.priceAdjustment,
        fee: settle.fee,
      });
    });

    await this.orderProductMappingRepository.save(orderProductList);
    await this.orderRepository.update({ id: orderId }, { settleAmount: settleAmount + settleFee });
  }

  @Transactional()
  async updateOrderSettle(getBody: OrderUpdateSettleReqDto) {
    const { list } = getBody;

    if (list.length === 0) {
      return;
    }

    const orderProductIds = list.map((item) => item.id);

    const existingOrderProducts = await this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .where('orderProductMapping.id IN (:...orderProductIds)', { orderProductIds })
      .getMany();

    const existingOrderProductMap = new Map(existingOrderProducts.map((order) => [order.id, order]));

    const missOrderProductIds = orderProductIds.filter((id) => !existingOrderProductMap.has(id));
    if (missOrderProductIds.length > 0) {
      throw new BadRequestException('존재하지 않는 주문 내역이 있습니다');
    }

    const orderId = existingOrderProducts[0].orderId;
    const settleAmount = existingOrderProducts[0].order.sendAmount;
    let settleFee = 0;

    const orderProductList = list.map((settle) => {
      const oneOrderProduct = existingOrderProductMap.get(settle.id);
      if (!oneOrderProduct) {
        throw new InternalServerErrorException('not exist order product');
      }

      if (settle.priceAdjustment === 'DISCOUNT') {
        settleFee -= (oneOrderProduct.product.price * (settle.fee ?? 0)) / 100;
      }

      if (settle.priceAdjustment === 'ADDITIONAL') {
        settleFee += (oneOrderProduct.product.price * (settle.fee ?? 0)) / 100;
      }
      // 이미 db에 있는 id 들을 create 에 넣으면 type orm 에서 update 로 동작한다
      return this.orderProductMappingRepository.create({
        id: settle.id,
        settleDiscountType: settle.settleDiscountType,
        priceAdjustment: settle.priceAdjustment,
        fee: settle.fee,
      });
    });

    await this.orderProductMappingRepository.save(orderProductList);
    await this.orderRepository.update({ id: orderId }, { settleAmount: settleAmount + settleFee });
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

      fromEmail,
      useEmailContent,
      emailSendType,

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

    const prevProduct = await this.orderRepository.findOne({
      where: {
        code: Like(`${OrderPrefixCode}%`),
      },
      order: { code: 'DESC' },
    });

    const prevCode = prevProduct?.code ?? null;

    const newCode = CreateCode(prevCode, OrderPrefixCode, OrderDigitNumber);

    for (const orderProduct of orderProductList) {
      const getProduct = productPriceMap.get(orderProduct.productId)!;
      sendAmount += getProduct.price * orderProduct.amount;
    }

    const orderInsertResult = await this.orderRepository.insert({
      userId: user.id,
      status: IOrderStatus.TEMP,
      code: newCode,
      type,
      eventName,
      sendMethod,
      sendTailText,
      requestToDestroyPersonalInfoDay,
      fromPhoneNumber,
      sendTitle,
      sendContent,
      fromEmail,
      emailSendType,
      useEmailContent,
      sendAmount: sendAmount,
      settleAmount: sendAmount,
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
      fromEmail,
      emailSendType,
      useEmailContent,
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

    order.fromEmail = fromEmail;
    order.emailSendType = emailSendType;
    order.useEmailContent = useEmailContent;

    order.sendTitle = sendTitle;
    order.sendContent = sendContent;

    order.sendAmount = sendAmount;
    order.settleAmount = sendAmount;
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
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id = :id', { id })
      .andWhere('order.userId = :userId', { userId: user.id })
      .getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않습니다.');
    }

    if (!order.orderProductMappings || order.orderProductMappings.length === 0) {
      throw new BadRequestException('발송 상세를 입력하지 않았습니다.');
    }

    for (const orderMapping of order.orderProductMappings!) {
      if (!orderMapping.orderDeliveries || orderMapping.orderDeliveries.length === 0) {
        throw new BadRequestException('발송 상세를 입력하지 않았습니다.');
      }
    }

    OrderValidation(order);

    // 신세계 상품 검증
    if (order.type === IOrderType.SSG) {
      // 상품 가격으로 전체 가격 계산
      const totalPrice = order.orderProductMappings!.reduce((acc, cur) => acc + cur.product.price * cur.amount, 0);
      const couponExpiration = order.orderProductMappings[0].product.expireDay;

      const now = new Date();
      const ssgEventList = await this.ssgEventRepository.find({
        where: {
          startAt: LessThanOrEqual(now),
          endAt: MoreThanOrEqual(now),
          couponExpiration: couponExpiration,
        },
        order: { order: 'desc' },
      });

      if (ssgEventList.length === 0) {
        throw new BadRequestException('행사가 존재하지 않습니다.');
      }

      const ssgEventTotalPrice = ssgEventList.reduce((acc, cur) => acc + cur.eventPrice, 0);

      if (ssgEventTotalPrice < totalPrice) {
        throw new BadRequestException('행사 잔액이 부족합니다.');
      }
    }

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
  async deliveryConfirmed(
    user: ILoginUserInfo,
    getBody: OrderDeliveryConfirmedReqDto,
  ): Promise<OrderDeliveryConfirmed> {
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
      throw new BadRequestException('해당 주문건은 존재하지 않거나, 발송 상세를 입력하지 않았습니다.');
    }

    OrderValidation(order);

    let ssgEventIssue: SsgEventEntity | null = null;
    // 신세계 상품 검증 및 차감
    if (order.type === IOrderType.SSG) {
      // 상품 가격으로 전체 가격 계산
      const totalPrice = order.sendAmount;
      const couponExpiration = order.orderProductMappings![0].orderDeliveries[0].orderProductMapping.product.expireDay;

      const now = new Date();
      const ssgEventList = await this.ssgEventRepository.find({
        where: {
          startAt: LessThanOrEqual(now),
          endAt: MoreThanOrEqual(now),
          couponExpiration: couponExpiration,
        },
        order: { order: 'desc' },
      });

      if (ssgEventList.length === 0) {
        throw new BadRequestException('행사가 존재하지 않습니다.');
      }

      const ssgEventTotalPrice = ssgEventList.reduce((acc, cur) => acc + cur.eventPrice, 0);

      if (ssgEventTotalPrice < totalPrice) {
        throw new BadRequestException('행사 잔액이 부족합니다.');
      }

      const ssgEventAmountHistoryList: SsgEventAmountHistoryEntity[] = [];

      for (const ssgEvent of ssgEventList) {
        ssgEventIssue = ssgEvent;
        const totalBalance = ssgEvent.eventBalance - totalPrice;

        ssgEvent.eventBalance = totalBalance > 0 ? totalBalance : 0;
        const ssgEventAmountEntity = new SsgEventAmountHistoryEntity();
        ssgEventAmountEntity.ssgEventId = ssgEvent.id;
        ssgEventAmountEntity.amount = -totalPrice;
        ssgEventAmountEntity.balance = totalBalance;
        ssgEventAmountEntity.orderId = order.id;

        ssgEventAmountHistoryList.push(ssgEventAmountEntity);
        if (totalBalance !== 0) {
          break;
        }
      }

      await this.ssgEventRepository.save(ssgEventList);
      await this.ssgEventAmountHistoryRepository.save(ssgEventAmountHistoryList);
    }

    let message = 'success';

    for (const orderMapping of order.orderProductMappings!) {
      for (const orderDelivery of orderMapping.orderDeliveries) {
        await this.partnerCompanyExternService.issue(orderDelivery, ssgEventIssue);
        // issue, 발급이 실패하지 않앗을 경우
        if (orderDelivery.status === IOrderDeliveryStatus.FAIL || !orderDelivery.barCode) {
          message = 'fail';
          throw new InternalServerErrorException('발급 실패');
        }

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
            orderDelivery.orderProductMapping.product.type,
          );
          orderDelivery.imagePath = path;
          orderDelivery.ssgEventId = ssgEventIssue ? ssgEventIssue.id : null;
        }

        await this.orderDeliveryRepository.save(orderDelivery);
      }
    }

    order.status = IOrderStatus.DELIVERY_CONFIRMED;
    await this.orderRepository.save(order);

    return { message: message };
  }

  @Transactional()
  async ssgCouponExpireChange(user: ILoginUserInfo, getBody: OrderDeliverySsgCouponExpireChangeReqDto) {
    const { id, couponExpiration } = getBody;

    const beforeOrder = await this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .where('order.id = :id', { id })
      // .andWhere('order.userId = :userId', { userId: user.id })
      .andWhere('order.status = :status', { status: IOrderStatus.DELIVERY_REQUEST })
      .andWhere('order.type = :type', { type: IOrderType.SSG })
      .getOne();

    if (!beforeOrder) {
      throw new BadRequestException('해당 주문건은 존재하지 않습니다.');
    }

    const couponExpirationProduct = beforeOrder.orderProductMappings![0].product.expireDay;

    if (couponExpiration === couponExpirationProduct) {
      throw new BadRequestException(`유효기간이 ${couponExpiration}일 로 동일합니다.`);
    }

    const afterProductList = await this.productRepository.find({
      where: {
        type: IProductType.SSG,
        expireDay: couponExpiration,
      },
    });
    const afterProductPriceMap = listToMapValue(
      afterProductList,
      (product) => product.price,
      (product) => product.id,
    );

    for (const orderProductMapping of beforeOrder.orderProductMappings!) {
      const beforeProductId = orderProductMapping.productId;
      const afterProductId = afterProductPriceMap.get(orderProductMapping.product.price);
      if (!afterProductId) {
        throw new InternalServerErrorException('신세계 product 가 존재하지 않습니다.');
      }

      await this.orderProductMappingRepository.update(
        {
          orderId: beforeOrder.id,
          productId: beforeProductId,
        },
        {
          productId: afterProductId,
        },
      );
    }

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .where('order.id = :id', { id })
      // .andWhere('order.userId = :userId', { userId: user.id })
      .andWhere('order.status = :status', { status: IOrderStatus.DELIVERY_REQUEST })
      .andWhere('order.type = :type', { type: IOrderType.SSG })
      .getOne();
    // 현재 order 에 되어있는 모든 product id 를 추출, 가격이 같은 다른 couponExpireation 으로 변경 진행
    if (!order) {
      throw new InternalServerErrorException('해당 주문이 존재하지 않습니다.');
    }

    // // 상품 가격으로 전체 가격 계산
    const totalPrice = order.sendAmount;

    const now = new Date();
    const ssgEventList = await this.ssgEventRepository.find({
      where: {
        startAt: LessThanOrEqual(now),
        endAt: MoreThanOrEqual(now),
        couponExpiration: couponExpiration,
      },
      order: { order: 'desc' },
    });

    if (ssgEventList.length === 0) {
      throw new BadRequestException('행사가 존재하지 않습니다.');
    }

    const ssgEventTotalPrice = ssgEventList.reduce((acc, cur) => acc + cur.eventPrice, 0);

    if (ssgEventTotalPrice < totalPrice) {
      throw new BadRequestException('행사 잔액이 부족합니다.');
    }

    return;
  }

  @Transactional()
  async deliveryCancel(user: ILoginUserInfo, getBody: OrderDeliveryCancelReqDto) {
    const { id } = getBody;

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .where('order.id = :id', { id })
      // .andWhere('order.userId = :userId', { userId: user.id })
      // .andWhere('order.status = :status', { status: 'DELIVERY_REQUEST' })
      .getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않습니다.');
    }

    const now = new Date();
    const sendRequestAtTime = order.sendRequestAt.getTime();
    const nowTime = now.getTime();
    const diffMs = sendRequestAtTime - nowTime;
    const tenMinutesMs = 10 * 60 * 1000;

    if (order.status === IOrderStatus.DELIVERY_REQUEST) {
      // 취소 허용
    } else if (order.status === IOrderStatus.DELIVERY_CONFIRMED) {
      if (diffMs < tenMinutesMs) {
        throw new BadRequestException('주문 취소는 발송 요청 시간 10분 전까지만 가능합니다.');
      }
    } else {
      throw new BadRequestException('주문 취소가 불가능한 상태입니다.');
    }

    if (!order.orderProductMappings || order.orderProductMappings.length === 0) {
      throw new BadRequestException('발송 상세가 존재하지 않습니다.');
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

  async excelDownload(user: ILoginUserInfo, getBody: OrderExcelDownloadReqBodyDto) {
    const { eventName, type, status, userId, startAt, endAt, section } = getBody;

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
      if (user.authority === IUserAuthority.CORPORATE_ADMIN) {
        queryBuilder = queryBuilder.andWhere('order.userId = :userId', { userId: user.id });
      }
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
      { header: '등록일', key: 'registerAt', width: 32 },
      { header: '고객사', key: 'userBusinessName', width: 20 },
      { header: '담당자', key: 'userPersonName', width: 20 },
      { header: '이벤트명', key: 'eventName', width: 20 },
      { header: '상품명', key: 'productName', width: 32 },
      { header: '발송수량', key: 'totalAmount', width: 32 },
      { header: '발송금액', key: 'sendAmount', width: 32 },
      { header: '정산금액', key: 'settleAmount', width: 40 },
      { header: '진행상태', key: 'status', width: 40 },
      { header: '발송시간', key: 'sendRequestAt', width: 40 },
    ];

    let id = 1;
    for (const order of orderList) {
      const sendRequestAt = normalizeDate(order.sendRequestAt) ? format(order.sendRequestAt, 'yyyy-MM-dd HH:mm') : null;

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
        id: id,
        registerAt: format(order.registerAt, 'yyyy-MM-dd HH:mm'),
        userBusinessName: order.user!.businessName,
        userPersonName: order.user!.personName,
        eventName: order.eventName,
        productName: productName,
        totalAmount: totalAmount,
        sendAmount: order.sendAmount,
        settleAmount: order.settleAmount,
        status: OrderStatusExcelMapping(order.status),
        sendRequestAt: sendRequestAt ?? '',
      });
      id++;
    }

    const fileName = `${orderType}_리스트_${nowString}.xlsx`;
    const filePath = join(process.cwd(), '.', 'public', fileName);

    await workbook.xlsx.writeFile(filePath);

    return { fileName, filePath };
  }

  async getMyOrderHistory(user: ILoginUserInfo): Promise<OrderGetMyOrderHistoryResDto> {
    const completeCount = await this.orderRepository.count({
      where: {
        userId: user.id,
        status: IOrderStatus.DELIVERY_REQUEST,
      },
    });

    const notProcessCount = await this.orderRepository.count({
      where: {
        userId: user.id,
        status: IOrderStatus.DELIVERY_CANCEL,
      },
    });

    const stockOrderCount = await this.orderRepository.count({
      where: {
        userId: user.id,
        status: IOrderStatus.DELIVERY_COMPLETE,
      },
    });

    return {
      waitingDepositCount: 0,
      completeCount,
      notProcessCount,
      stockOrderCount,
    };
  }
}
