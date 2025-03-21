import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { OrderRealProductEntity } from '../../entity/order.real.product.entity';
import { OrderRealProductGetListResDto } from '../api/order.real.product.res.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import {
  OrderRealProductConfirmRequestReqDto,
  OrderRealProductCreateReqDto,
  OrderRealProductDeliveryTrackingReqDto,
  OrderRealProductExcelDownloadReqBodyDto,
  OrderRealProductGetDetailReqParamDto,
  OrderRealProductGetListReqDto,
  OrderRealProductTaxInfoUpdateReqDto,
  OrderRealProductUpdateRequestReqDto,
} from '../api/order.real.product.req.dto';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import { format } from 'date-fns';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { OrderRealProductViewDto } from '../api/dto/order.real.product.view.dto';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { UserEntity } from '../../entity/user.entity';
import { OrderRealProductMappingEntity } from '../../entity/order.real.product.mapping.entity';
import { IOrderRealProductStatus } from '../interface/order.real.product.status';
import { ProductEntity } from '../../entity/product.entity';
import { IOrderSection } from '../../order/interface/order.section';
import { IUserAuthority } from '../../user/interface/user.authority';
import { OrderRealProductDetailDto } from '../api/dto/order.real.product.detail.dto';
import { RealProductViewDto } from '../api/dto/real.product.view.dto';
import { PublicChargeTaxViewDto } from '../api/dto/public.charge.tax.view.dto';
import { DeliveryTrackHttp } from '../../delivery/infra/delivery.track.http';
import { join } from 'path';
import * as process from 'node:process';
import * as ExcelJS from 'exceljs';
import { OrderRealProductStatusExcelMapping } from '../domain/order.real.product.status.excel.mapping';

export class OrderRealProductService {
  constructor(
    @InjectRepository(OrderRealProductEntity)
    private orderRepository: Repository<OrderRealProductEntity>,
    @InjectRepository(OrderRealProductMappingEntity)
    private orderProductMappingRepository: Repository<OrderRealProductMappingEntity>,
    @InjectRepository(ProductEntity)
    private productRepository: Repository<ProductEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private deliveryTrackHttp: DeliveryTrackHttp,
  ) {}

  async getList(user: ILoginUserInfo, getQuery: OrderRealProductGetListReqDto): Promise<OrderRealProductGetListResDto> {
    const { page, take, eventName, startAt, endAt, userBusinessId, status, section } = getQuery;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.businessUser', 'businessUser')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.orderRealProductMappings', 'orderRealProductMappings')
      .leftJoinAndSelect('orderRealProductMappings.product', 'product');

    // 주문 관리 일 경우(최고관리자가 아닐 경우 자신이 등록한 주문만 조회)
    if (section === IOrderSection.ORDER) {
      if (user.authority !== IUserAuthority.SUPER_ADMIN) {
        queryBuilder = queryBuilder.andWhere('order.userId = :userId', { userId: user.id });
      }
    }

    // 발송관리 일 경우
    if (section === IOrderSection.SHIPPING) {
      // 고객사 담당자 인 경우
      if (user.authority === IUserAuthority.CORPORATE_ADMIN) {
        queryBuilder = queryBuilder.andWhere('order.businessUserId = :userId', { userId: user.id });
      }

      // 운영, 최고관리자 인 경우
      if (user.authority === IUserAuthority.OPERATION_ADMIN || user.authority === IUserAuthority.SUPER_ADMIN) {
        queryBuilder = queryBuilder.andWhere('order.userId = :userId', { userId: user.id });
      }
    }

    if (status) {
      queryBuilder = queryBuilder.andWhere('orderRealProductMappings.status = :status', { status });
    }

    if (userBusinessId) {
      queryBuilder = queryBuilder.andWhere('order.userBusinessId = :userBusinessId', {
        userBusinessId,
      });
    }

    if (eventName) {
      queryBuilder = queryBuilder.andWhere('order.eventName LIKE :eventName', { eventName: `%${eventName}%` });
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'order', 'createdAt', startAt, endAt);

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.take(take).skip(skip);

    const [orderRealProductList, totalCount] = await queryBuilder.getManyAndCount();
    const totalPage = Math.ceil(totalCount / take);

    const resultList: OrderRealProductViewDto[] = orderRealProductList.map((order) => {
      let totalAmount = 0;
      let totalProductCount = 0;
      let productName = '';

      if (order.orderRealProductMappings && order.orderRealProductMappings.length > 0) {
        totalAmount = order.orderRealProductMappings.reduce((acc, cur) => {
          return acc + cur.totalPrice;
        }, 0);
        totalProductCount = order.orderRealProductMappings.length;
        const orderProductMappingsLength = order.orderRealProductMappings.length;
        if (orderProductMappingsLength - 1 > 0) {
          productName += ` 외 ${orderProductMappingsLength - 1}건`;
        }
      }

      return {
        id: order.id,
        registerAt: format(order.createdAt, DateFormatStr),
        userBusinessName: order.businessUser!.businessName,
        userPersonName: order.user!.personName,
        eventName: order.eventName,
        productName,
        totalProductCount,
        totalAmount,
        status: order.status,
        finishedAt: order.finishedAt ? format(order.finishedAt, DateFormatStr) : null,
      };
    });

    return {
      list: resultList,
      currentPage: page,
      totalCount,
      totalPage,
    };
  }

  async order(user: ILoginUserInfo, getBody: OrderRealProductCreateReqDto) {
    const {
      publicChargeTaxPayment,
      processMethod,
      isProcess,
      orderRealProductList,
      standardAmount,
      price,
      userId,
      eventName,
    } = getBody;

    if (user.authority !== IUserAuthority.SUPER_ADMIN && user.authority !== IUserAuthority.OPERATION_ADMIN) {
      throw new UnauthorizedException('최고, 운영 관리자만 접근 가능합니다.');
    }

    const userBusiness = await this.userRepository.findOne({
      where: {
        id: userId,
      },
    });

    if (!userBusiness) {
      throw new BadRequestException('존재하지 않는 고객사 입니다.');
    }

    const realProductIdList = orderRealProductList.map((product) => product.productId);
    const uniqueProductId = new Set(realProductIdList);

    if (uniqueProductId.size !== realProductIdList.length) {
      throw new BadRequestException('중복 상품이 존재합니다.');
    }

    const realProductList = await this.productRepository.find({
      where: {
        id: In(realProductIdList),
      },
    });

    if (!realProductList) {
      throw new BadRequestException('존재하지 않는 실물 상품 입니다.');
    }

    if (realProductList.length !== realProductIdList.length) {
      throw new BadRequestException('존재하지 않는 상품을 추가하였습니다.');
    }

    const savedOrder = this.orderRepository.create({
      businessUserId: userBusiness.id,
      userId: user.id,
      eventName: eventName,
      status: IOrderRealProductStatus.ORDER_PENDING,
    });

    await this.orderRepository.save(savedOrder);

    // 주문, 세금 합계 금액 계산(부가세 10%, 제세공과금 10%)
    const totalPrice = price + price * 0.1;
    const totalTaxAmount = standardAmount + standardAmount * 0.1;

    for (const realProduct of orderRealProductList) {
      const orderRealProduct = new OrderRealProductMappingEntity();
      const quantity = realProduct.quantity;

      orderRealProduct.realProductOrderId = savedOrder.id;
      orderRealProduct.productId = realProduct.productId;
      orderRealProduct.price = price;
      orderRealProduct.quantity = quantity;
      orderRealProduct.totalPrice = totalPrice * quantity;
      orderRealProduct.processMethod = processMethod;
      orderRealProduct.standardAmount = standardAmount;
      orderRealProduct.totalTaxAmount = totalTaxAmount * quantity;
      orderRealProduct.publicChargeTaxPayment = publicChargeTaxPayment;
      orderRealProduct.isProcess = isProcess;
      orderRealProduct.processMethod = processMethod;
      await this.orderProductMappingRepository.save(orderRealProduct);
    }
  }

  async getDetail(
    user: ILoginUserInfo,
    getParam: OrderRealProductGetDetailReqParamDto,
  ): Promise<OrderRealProductDetailDto> {
    const { id } = getParam;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.orderRealProductMappings', 'orderRealProductMappings')
      .leftJoinAndSelect('orderRealProductMappings.product', 'product')
      .leftJoinAndSelect('order.businessUser', 'businessUser')
      .leftJoinAndSelect('order.user', 'user')
      .where('order.id = :id', { id });

    if (user.authority !== IUserAuthority.OPERATION_ADMIN && user.authority !== IUserAuthority.SUPER_ADMIN) {
      queryBuilder = queryBuilder.andWhere('order.businessUserId = :businessUserId', { businessUserId: user.id });
    }

    const order = await queryBuilder.getOne();

    if (!order) {
      throw new BadRequestException('존재하지 않는 주문 입니다.');
    }

    if (!order.orderRealProductMappings && order.orderRealProductMappings > 0) {
      throw new BadRequestException('주문 상세 정보가 없습니다.');
    }

    const orderRealProductList: RealProductViewDto[] = [];
    const publicChargeTaxList: PublicChargeTaxViewDto[] = [];

    for (const mapping of order.orderRealProductMappings) {
      orderRealProductList.push({
        mappingId: mapping.id,
        productId: mapping.product.id,
        productName: mapping.product.name,
        code: mapping.product.code,
        color: mapping.product.color,
        quantity: mapping.quantity,
        price: mapping.price,
        vat: Math.floor(mapping.price * 0.1),
        totalAmount: mapping.totalPrice,
      });

      publicChargeTaxList.push({
        mappingId: mapping.id,
        productId: mapping.product.id,
        productName: mapping.product.name,
        code: mapping.product.code,
        quantity: mapping.quantity,
        standardAmount: mapping.standardAmount,
        tax: Math.floor(mapping.standardAmount * 0.1),
        totalTaxAmount: mapping.totalTaxAmount,
        publicChargeTaxPaymentType: mapping.publicChargeTaxPayment,
        processMethod: mapping.processMethod,
        isProcess: mapping.isProcess,
      });
    }

    return {
      id: order.id,
      registerAt: format(order.createdAt, DateFormatStr),
      userBusinessName: order.businessUser ? order.businessUser.businessName : null,
      userName: order.user ? order.user.personName : null,
      eventName: order.eventName,
      orderRealProductList: orderRealProductList,
      publicChargeTaxList: publicChargeTaxList,
    };
  }

  async updateRequest(user: ILoginUserInfo, getBody: OrderRealProductUpdateRequestReqDto): Promise<void> {
    const { id } = getBody;

    if (user.authority !== IUserAuthority.CORPORATE_ADMIN) {
      throw new UnauthorizedException('고객사 담당자만 가능합니다.');
    }

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.orderRealProductMappings', 'orderRealProductMappings')
      .where('order.id = :id', { id })
      .andWhere('order.businessUserId = :businessUserId', { businessUserId: user.id })
      .getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않습니다.');
    }

    order.status = IOrderRealProductStatus.ORDER_EDIT_REQUEST;
    await this.orderRepository.save(order);

    return;
  }

  async updateApprove(user: ILoginUserInfo, getBody: OrderRealProductUpdateRequestReqDto): Promise<void> {
    const { id } = getBody;

    if (user.authority === IUserAuthority.CORPORATE_ADMIN) {
      throw new UnauthorizedException('최고,운영 관리자만 접근 가능합니다.');
    }

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.orderRealProductMappings', 'orderRealProductMappings')
      .where('order.id = :id', { id })
      .andWhere('order.businessUserId = :businessUserId', { businessUserId: user.id })
      .getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않습니다.');
    }

    order.status = IOrderRealProductStatus.ORDER_PENDING; // 주문 진행중으로 수정
    await this.orderRepository.save(order);

    return;
  }

  async orderConfirm(user: ILoginUserInfo, getBody: OrderRealProductConfirmRequestReqDto): Promise<void> {
    const { id } = getBody;

    if (user.authority !== IUserAuthority.CORPORATE_ADMIN) {
      throw new UnauthorizedException('고객사 담당자만 가능합니다.');
    }

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.orderRealProductMappings', 'orderRealProductMappings')
      .where('order.id = :id', { id })
      // .andWhere('order.userId = :userId', { userId: user.id })
      .getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않습니다.');
    }

    order.status = IOrderRealProductStatus.ORDER_CONFIRM;
    await this.orderRepository.save(order);

    return;
  }

  async getDeliveryTrackingStatus(
    user: ILoginUserInfo,
    getQuery: OrderRealProductDeliveryTrackingReqDto,
  ): Promise<any> {
    const { carrierId, trackingNumber } = getQuery;

    const response = await this.deliveryTrackHttp.trackDeliveryLastInfo(carrierId, trackingNumber);

    return {
      success: true,
      data: response.data.track.lastEvent || null,
    };
  }

  async getDeliveryTrackingDetail(
    user: ILoginUserInfo,
    getQuery: OrderRealProductDeliveryTrackingReqDto,
  ): Promise<any> {
    const { carrierId, trackingNumber } = getQuery;

    const response = await this.deliveryTrackHttp.trackDeliveryDetail(carrierId, trackingNumber);

    return {
      lastEvent: response.data.track.lastEvent || null,
      events: response.data.track.events?.edges?.map((edge) => edge.node) || [],
    };
  }

  async updateTaxInfo(user: ILoginUserInfo, getBody: OrderRealProductTaxInfoUpdateReqDto): Promise<void> {
    const { list } = getBody;

    const mappingIds = list.map((mapping) => mapping.mappingId);

    const mappings = await this.orderProductMappingRepository.find({
      where: {
        id: In(mappingIds),
      },
    });

    if (mappings.length !== mappingIds.length) {
      throw new BadRequestException('유효하지 않는 id 가 포함되어 있습니다.');
    }

    for (const mapping of mappings) {
      const taxInfo = list.find((item) => item.mappingId === mapping.id);
      if (!taxInfo) continue;

      mapping.publicChargeTaxPayment = taxInfo.publicChargeTaxPayment;
      mapping.processMethod = taxInfo.processMethod;
      mapping.isProcess = taxInfo.isProcess;
    }

    await this.orderProductMappingRepository.save(mappings);
  }

  async excelDownload(user: ILoginUserInfo, getBody: OrderRealProductExcelDownloadReqBodyDto) {
    const { eventName, status, userBusinessId, startAt, endAt, section } = getBody;

    const now = new Date();
    const nowString = format(now, 'yyyyMMdd');
    let orderType = '';

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.businessUser', 'businessUser')
      .leftJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.orderRealProductMappings', 'orderRealProductMappings')
      .leftJoinAndSelect('orderRealProductMappings.product', 'product');

    // 주문 관리 일 경우(최고관리자가 아닐 경우 자신이 등록한 주문만 조회)
    if (section === IOrderSection.ORDER) {
      if (user.authority !== IUserAuthority.SUPER_ADMIN) {
        queryBuilder = queryBuilder.andWhere('order.userId = :userId', { userId: user.id });
      }
      orderType = '주문';
    }

    // 발송관리 일 경우
    if (section === IOrderSection.SHIPPING) {
      // 고객사 담당자 인 경우
      if (user.authority === IUserAuthority.CORPORATE_ADMIN) {
        queryBuilder = queryBuilder.andWhere('order.businessUserId = :userId', { userId: user.id });
      }

      // 운영, 최고관리자 인 경우
      if (user.authority === IUserAuthority.OPERATION_ADMIN || user.authority === IUserAuthority.SUPER_ADMIN) {
        queryBuilder = queryBuilder.andWhere('order.userId = :userId', { userId: user.id });
      }

      orderType = '발송';
    }

    if (status) {
      queryBuilder = queryBuilder.andWhere('order.status = :status', { status });
    }

    if (userBusinessId) {
      queryBuilder = queryBuilder.andWhere('order.userBusinessId = :userBusinessId', { userBusinessId });
    }

    if (eventName) {
      queryBuilder = queryBuilder.andWhere('order.eventName LIKE :eventName', { eventName: `%${eventName}%` });
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'order', 'sendRequestAt', startAt, endAt);

    const orderList = await queryBuilder.getMany();

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(`sheet1`);

    sheet.columns = [
      { header: '번호', key: 'id', width: 10 },
      { header: '등록일', key: 'registerAt', width: 32 },
      { header: '고객사', key: 'userBusinessName', width: 20 },
      { header: '담당자', key: 'userName', width: 20 },
      { header: '이벤트명', key: 'eventName', width: 20 },
      { header: '상품명', key: 'productName', width: 32 },
      { header: '품목수', key: 'totalProductCount', width: 32 },
      { header: '총금액', key: 'totalAmount', width: 32 },
      { header: '진행상태', key: 'status', width: 40 },
      { header: '최종완료시간', key: 'finishedAt', width: 40 },
    ];

    let id = 1;
    for (const order of orderList) {
      let totalAmount = 0;
      let totalProductCount = 0;
      let productName = '';

      if (order.orderRealProductMappings && order.orderRealProductMappings.length > 0) {
        totalAmount = order.orderRealProductMappings.reduce((acc, cur) => {
          return acc + cur.totalPrice;
        }, 0);
        totalProductCount = order.orderRealProductMappings.length;
        productName = order.orderRealProductMappings[0].product?.name;
        const orderProductMappingsLength = order.orderRealProductMappings.length;
        if (orderProductMappingsLength - 1 > 0) {
          productName += ` 외 ${orderProductMappingsLength - 1}건`;
        }
      }

      sheet.addRow({
        id: id,
        registerAt: format(order.createdAt, 'yyyy-MM-dd HH:mm'),
        userBusinessName: order.user!.businessName,
        userName: order.user!.personName,
        eventName: order.eventName,
        productName: productName,
        totalAmount: totalAmount,
        totalProductCount: totalProductCount,
        status: OrderRealProductStatusExcelMapping(order.status),
        finishedAt: order.finishedAt ? format(order.finishedAt, 'yyyy-MM-dd HH:mm') : '',
      });
      id++;
    }

    const fileName = `실물상품_${orderType}_리스트_${nowString}.xlsx`;
    const filePath = join(process.cwd(), '.', 'public', fileName);

    await workbook.xlsx.writeFile(filePath);

    return { fileName, filePath };
  }
}
