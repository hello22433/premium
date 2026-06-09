import { InjectRepository } from '@nestjs/typeorm';
import { createExportTempPath } from '../../util/file.util';
import { Brackets, In, Repository } from 'typeorm';
import { OrderRealProductEntity } from '../../entity/order.real.product.entity';
import {
  OrderRealProductGetAdminListResDto,
  OrderRealProductGetDeliveryCompleteReportResDto,
  OrderRealProductGetDeliveryTrackDetailResDto,
  OrderRealProductGetDeliveryTrackingLastEventResDto,
  OrderRealProductGetDetailResDto,
  OrderRealProductGetListResDto,
  OrderRealProductGetSettlementListResDto,
  OrderRealProductMappingGetDetailResDto,
} from '../api/order.real.product.res.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import {
  OrderRealProductConfirmRequestReqDto,
  OrderRealProductCreateReqDto,
  OrderRealProductDeliveryTrackingGetDetailReqParamDto,
  OrderRealProductDeliveryTrackingReqDto,
  OrderRealProductExcelDownloadReqBodyDto,
  OrderRealProductGetAdminListReqDto,
  OrderRealProductGetDeliveryCompleteReportReqDto,
  OrderRealProductGetDetailReqParamDto,
  OrderRealProductGetListReqDto,
  OrderRealProductGetSettlementExcelDownloadReqDto,
  OrderRealProductGetSettlementListReqDto,
  OrderRealProductMappingGetDetailReqParamDto,
  OrderRealProductMappingUpdateReqDto,
  OrderRealProductUpdateReqDto,
  OrderRealProductUpdateRequestReqDto,
} from '../api/order.real.product.req.dto';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import { format } from 'date-fns';
import { DateDateFormatStr, DateFormatStr } from '../../common/domain/date.format.str';
import { OrderRealProductViewDto } from '../api/dto/order.real.product.view.dto';
import { BadRequestException } from '@nestjs/common';
import { UserEntity } from '../../entity/user.entity';
import { OrderRealProductMappingEntity } from '../../entity/order.real.product.mapping.entity';
import { IOrderRealProductStatus } from '../interface/order.real.product.status';
import { ProductEntity } from '../../entity/product.entity';
import { IOrderSection } from '../../order/interface/order.section';
import { IUserAuthority } from '../../user/interface/user.authority';
import { RealProductViewDto } from '../api/dto/real.product.view.dto';
import { PublicChargeTaxViewDto } from '../api/dto/public.charge.tax.view.dto';
import { DeliveryTrackHttp } from '../../delivery/infra/delivery.track.http';
import { join } from 'path';
import * as process from 'node:process';
import * as ExcelJS from 'exceljs';
import { OrderRealProductStatusExcelMapping } from '../domain/order.real.product.status.excel.mapping';
import { OrderRealProductSettleViewDto } from '../api/dto/order.real.product.settle.view.dto';
import { OrderCustomerViewDto } from '../../order/api/dto/order.customer.view.dto';
import { Transactional } from 'typeorm-transactional';
import { IUserStatus } from '../../user/interface/user.status';
import { AdminListViewDto } from '../../settle/api/dto/admin.list.view.dto';
import { OrderRealProductDeliveryViewDto } from '../api/dto/order.real.product.delivery.view.dto';
import { DeliveryTrackingStatus } from '../../delivery/domain/delivery.tracking.status';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';
import { IPublicChargeTaxPaymentType } from '../interface/public.charge.tax.payment.type';
import { CompanyType } from '../../common/domain/company.type';

/**
 * 제세공과금 계산 함수
 * @param standardAmount 기준가액 (단가)
 * @param quantity 수량
 * @param paymentType 납부방식
 * @returns { tax: 납세액, totalTaxAmount: 합계 }
 */
const calculateTax = (
  standardAmount: number,
  quantity: number,
  paymentType: IPublicChargeTaxPaymentType | null,
): { tax: number; totalTaxAmount: number } => {
  const totalStandardAmount = standardAmount * quantity;

  // 기준가 5만원 이하이거나 해당없음이면 세금 없음
  if (standardAmount <= 50000 || paymentType === IPublicChargeTaxPaymentType.NONE || !paymentType) {
    return {
      tax: 0,
      totalTaxAmount: totalStandardAmount,
    };
  }

  if (paymentType === IPublicChargeTaxPaymentType.PERSON) {
    // 고객납부: 기준가액의 22%
    const tax = Math.floor(totalStandardAmount * 0.22);
    return {
      tax,
      totalTaxAmount: totalStandardAmount + tax,
    };
  }

  if (paymentType === IPublicChargeTaxPaymentType.COMPANY) {
    // 고객사 대납
    // 소득세 = 상품금액 * 20% / 78% (1원 단위 버림 = 10원 단위로 절삭)
    const incomeTax = Math.floor((totalStandardAmount * 0.2) / 0.78 / 10) * 10;
    // 주민세 = 소득세 * 10% (1원 단위 버림 = 10원 단위로 절삭)
    const residentTax = Math.floor((incomeTax * 0.1) / 10) * 10;
    const tax = incomeTax + residentTax;
    return {
      tax,
      totalTaxAmount: totalStandardAmount + tax,
    };
  }

  return {
    tax: 0,
    totalTaxAmount: totalStandardAmount,
  };
};

const calculateRealProductSupplyTotal = (price: number, quantity: number): number => price * quantity;

const calculateRealProductVatTotal = (price: number, quantity: number): number =>
  Math.floor(calculateRealProductSupplyTotal(price, quantity) * 0.1);

const calculateRealProductVatIncludedTotal = (price: number, quantity: number): number =>
  calculateRealProductSupplyTotal(price, quantity) + calculateRealProductVatTotal(price, quantity);

function buildRealProductAndTaxLists(mappings: OrderRealProductMappingEntity[]): {
  orderRealProductList: RealProductViewDto[];
  publicChargeTaxList: PublicChargeTaxViewDto[];
} {
  const orderRealProductList: RealProductViewDto[] = [];
  const publicChargeTaxList: PublicChargeTaxViewDto[] = [];

  for (const mapping of mappings) {
    orderRealProductList.push({
      mappingId: mapping.id,
      productId: mapping.product.id,
      productName: mapping.product.name,
      code: mapping.product.code,
      color: mapping.product.color,
      quantity: mapping.quantity,
      price: mapping.price,
      trackingNumber: mapping.trackingNumber,
      vat: calculateRealProductVatTotal(mapping.price, mapping.quantity),
      totalAmount: calculateRealProductVatIncludedTotal(mapping.price, mapping.quantity),
    });

    const { tax, totalTaxAmount } = calculateTax(
      mapping.standardAmount,
      mapping.quantity,
      mapping.publicChargeTaxPayment,
    );
    publicChargeTaxList.push({
      mappingId: mapping.id,
      productId: mapping.product.id,
      productName: mapping.product.name,
      code: mapping.product.code,
      quantity: mapping.quantity,
      standardAmount: mapping.standardAmount,
      tax,
      totalTaxAmount,
      publicChargeTaxPaymentType: mapping.publicChargeTaxPayment,
      processMethod: mapping.processMethod,
      isProcess: mapping.isProcess,
    });
  }

  return { orderRealProductList, publicChargeTaxList };
}

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
    private activityLogService: ActivityLogService,
  ) { }

  async getList(user: ILoginUserInfo, getQuery: OrderRealProductGetListReqDto): Promise<OrderRealProductGetListResDto> {
    const { page, take, searchType, searchKeyword, startAt, endAt, status, section } = getQuery;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.businessUser', 'businessUser')
      .leftJoinAndSelect('businessUser.company', 'businessUserCompany')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.orderRealProductMappings', 'orderRealProductMappings')
      .leftJoinAndSelect('orderRealProductMappings.product', 'product')
      .orderBy('order.id', 'DESC');

    // 주문 관리 일 경우(최고관리자가 아닐 경우 자신이 등록한 주문 또는 담당자로 지정된 주문만 조회)
    if (section === IOrderSection.ORDER) {
      if (user.authority !== IUserAuthority.SUPER_ADMIN) {
        queryBuilder = queryBuilder.andWhere(
          '(order.userId = :userId OR order.businessUserId = :userId)',
          { userId: user.id },
        );
      }
    }

    // 발송관리 일 경우
    if (section === IOrderSection.SHIPPING) {
      // 고객사 담당자 인 경우
      if (user.authority === IUserAuthority.CORPORATE_ADMIN) {
        queryBuilder = queryBuilder.andWhere('order.businessUserId = :userId', { userId: user.id });
      }

      // 운영, 최고관리자 인 경우
      if (user.authority === IUserAuthority.OPERATION_ADMIN) {
        queryBuilder = queryBuilder.andWhere('order.userId = :userId', { userId: user.id });
      }
    }

    if (status) {
      queryBuilder = queryBuilder.andWhere('order.status = :status', { status });
    }

    // 검색 조건 처리 (최소 1자 이상일 때만 검색)
    if (searchKeyword && searchKeyword.length >= 1) {
      switch (searchType) {
        case 'CUSTOMER':
          queryBuilder = queryBuilder.andWhere('businessUserCompany.businessName LIKE :keyword', {
            keyword: `%${searchKeyword}%`,
          });
          break;
        case 'MANAGER':
          queryBuilder = queryBuilder.andWhere('user.personName LIKE :keyword', { keyword: `%${searchKeyword}%` });
          break;
        case 'EVENT':
          queryBuilder = queryBuilder.andWhere('order.eventName LIKE :keyword', { keyword: `%${searchKeyword}%` });
          break;
        case 'PRODUCT':
          queryBuilder = queryBuilder.andWhere('product.name LIKE :keyword', { keyword: `%${searchKeyword}%` });
          break;
        case 'ALL':
        default:
          queryBuilder = queryBuilder.andWhere(
            '(businessUserCompany.businessName LIKE :keyword OR user.personName LIKE :keyword OR order.eventName LIKE :keyword OR product.name LIKE :keyword)',
            { keyword: `%${searchKeyword}%` },
          );
          break;
      }
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
        userBusinessName: order.businessUser!.company?.businessName ?? '',
        userPersonName: order.businessUser!.personName,
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

  async getAdminUserList(getQuery: OrderRealProductGetAdminListReqDto): Promise<OrderRealProductGetAdminListResDto> {
    const { searchText, page, take } = getQuery;

    const queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .where('user.status = :status', { status: IUserStatus.USED })
      .andWhere('user.authority IN (:...authority)', {
        authority: [IUserAuthority.SUPER_ADMIN, IUserAuthority.OPERATION_ADMIN],
      });

    if (searchText) {
      queryBuilder.andWhere(
        '(user.personName LIKE :searchText OR userCompany.businessName LIKE :searchText OR user.email LIKE :searchText)',
        { searchText: `%${searchText}%` },
      );
    }

    const skip = (page - 1) * take;
    const [adminUserList, totalCount] = await queryBuilder.skip(skip).take(take).getManyAndCount();
    const totalPage = Math.ceil(totalCount / take);

    const resultList: AdminListViewDto[] = adminUserList.map((user) => {
      return {
        id: user.id,
        email: user.email,
        personName: user.personName,
        businessName: user.company?.businessName ?? '',
        status: user.status,
      };
    });

    return {
      list: resultList,
      totalCount,
      currentPage: page,
      totalPage,
    };
  }

  async order(user: ILoginUserInfo, getBody: OrderRealProductCreateReqDto) {
    const {
      publicChargeTaxPayment,
      processMethod,
      isProcess,
      orderRealProductList,
      userId,
      eventName,
    } = getBody;

    const userBusiness = await this.userRepository.findOne({
      where: {
        id: userId,
      },
    });

    if (!userBusiness) {
      throw new BadRequestException('존재하지 않는 고객사 입니다.');
    }

    const realProductIdList = orderRealProductList.map((product) => product.productId);

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
      userId: user.id, // 로그인한 관리자 user id
      businessUserId: userBusiness.id, // 고객사 id
      eventName: eventName,
      status: IOrderRealProductStatus.ORDER_PENDING,
    });

    await this.orderRepository.save(savedOrder);

    // productId를 key로 하는 상품 Map 생성 (정가 조회용)
    const productMap = new Map(realProductList.map((p) => [p.id, p]));

    for (const realProduct of orderRealProductList) {
      const orderRealProduct = new OrderRealProductMappingEntity();
      const quantity = realProduct.quantity;
      const price = realProduct.price ?? 0; // 각 상품별 공급가액 (단가)

      if (!price || price <= 0) {
        throw new BadRequestException('공급가액을 입력해주세요.');
      }

      // 상품 정가를 기준가액으로 사용 (제세공과금 계산용)
      const product = productMap.get(realProduct.productId);
      const productStandardAmount = product ? product.price : 0;
      const totalTaxAmount = productStandardAmount + Math.floor(productStandardAmount * 0.1);

      orderRealProduct.realProductOrderId = savedOrder.id;
      orderRealProduct.productId = realProduct.productId;
      orderRealProduct.price = price;
      orderRealProduct.quantity = quantity;
      orderRealProduct.totalPrice = calculateRealProductVatIncludedTotal(price, quantity);
      orderRealProduct.processMethod = processMethod;
      orderRealProduct.standardAmount = productStandardAmount;
      orderRealProduct.totalTaxAmount = totalTaxAmount * quantity;
      orderRealProduct.publicChargeTaxPayment = publicChargeTaxPayment;
      orderRealProduct.isProcess = isProcess;
      await this.orderProductMappingRepository.save(orderRealProduct);
    }
  }

  async getDetail(
    user: ILoginUserInfo,
    getParam: OrderRealProductGetDetailReqParamDto,
  ): Promise<OrderRealProductGetDetailResDto> {
    const { id } = getParam;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.orderRealProductMappings', 'orderRealProductMappings')
      .leftJoinAndSelect('orderRealProductMappings.product', 'product')
      .leftJoinAndSelect('order.businessUser', 'businessUser')
      .leftJoinAndSelect('businessUser.company', 'businessUserCompany')
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

    const { orderRealProductList, publicChargeTaxList } = buildRealProductAndTaxLists(order.orderRealProductMappings);

    return {
      id: order.id,
      status: order.status,
      registerAt: format(order.createdAt, DateFormatStr),
      userBusinessName: order.businessUser ? order.businessUser.company?.businessName ?? '' : null,
      userPersonName: order.businessUser ? order.businessUser.personName : null,
      eventName: order.eventName,
      orderRealProductList,
      publicChargeTaxList,
    };
  }

  async updateRequest(user: ILoginUserInfo, getBody: OrderRealProductUpdateRequestReqDto): Promise<void> {
    const { id } = getBody;

    // if (user.authority !== IUserAuthority.CORPORATE_ADMIN) {
    //   throw new UnauthorizedException('고객사 담당자만 가능합니다.');
    // }

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.orderRealProductMappings', 'orderRealProductMappings')
      .where('order.id = :id', { id })
      .andWhere('order.businessUserId = :businessUserId', { businessUserId: user.id })
      .getOne();

    if (!order) {
      throw new BadRequestException('존재하지 않는 주문입니다.');
    }

    order.status = IOrderRealProductStatus.ORDER_EDIT_REQUEST;
    await this.orderRepository.save(order);

    return;
  }

  async updateApprove(user: ILoginUserInfo, getBody: OrderRealProductUpdateRequestReqDto): Promise<void> {
    const { id } = getBody;

    // 수정요청 승인은 관리자만 가능
    if (user.authority !== IUserAuthority.SUPER_ADMIN && user.authority !== IUserAuthority.OPERATION_ADMIN) {
      throw new BadRequestException('수정요청 승인 권한이 없습니다.');
    }

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.orderRealProductMappings', 'orderRealProductMappings')
      .where('order.id = :id', { id })
      .getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않습니다.');
    }

    order.status = IOrderRealProductStatus.ORDER_PENDING; // 주문 진행중으로 수정
    await this.orderRepository.save(order);

    return;
  }

  async orderConfirm(getBody: OrderRealProductConfirmRequestReqDto): Promise<void> {
    const { id } = getBody;

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
    getQuery: OrderRealProductDeliveryTrackingReqDto,
  ): Promise<OrderRealProductGetDeliveryTrackingLastEventResDto> {
    const { id } = getQuery;

    const order = await this.orderRepository.findOne({
      where: {
        id,
      },
      relations: ['orderRealProductMappings', 'orderRealProductMappings.product', 'user', 'businessUser', 'businessUser.company'],
    });

    if (!order || order.orderRealProductMappings.length === 0) {
      throw new BadRequestException('존재하지 않는 주문이거나, 주문의 상세 정보가 존재하지 않습니다.');
    }

    const resultList: OrderRealProductDeliveryViewDto[] = [];

    for (const mapping of order.orderRealProductMappings) {
      const trackingNumber = mapping.trackingNumber;

      let code: DeliveryTrackingStatus = DeliveryTrackingStatus.UNKNOWN;

      if (trackingNumber) {
        const response = await this.deliveryTrackHttp.trackDeliveryLastInfo('kr.cjlogistics', trackingNumber);
        const lastEvent = response?.data?.track?.lastEvent;

        if (lastEvent?.status?.code) {
          code = lastEvent.status.code;
        }
      }

      resultList.push({
        id: order.id,
        registerAt: format(order.createdAt, DateDateFormatStr),
        userBusinessName: order.businessUser!.company?.businessName || null,
        userPersonName: order.businessUser!.personName || null,
        eventName: order.eventName,
        productName: mapping.product!.name || '',
        receiver: order.businessUser!.personName || null,
        businessAddress: order.businessUser!.company?.businessAddress || '',
        code,
      });
    }

    return {
      list: resultList,
    };
  }

  async getDeliveryTrackingDetail(
    getParam: OrderRealProductDeliveryTrackingGetDetailReqParamDto,
  ): Promise<OrderRealProductGetDeliveryTrackDetailResDto> {
    const { id } = getParam;

    const mapping = await this.orderProductMappingRepository.findOne({
      where: { id },
      relations: ['realProductOrder', 'realProductOrder.user', 'realProductOrder.businessUser', 'realProductOrder.businessUser.company', 'product'],
    });

    if (!mapping) {
      throw new BadRequestException('주문 매핑 정보를 찾을 수 없습니다.');
    }

    const trackingNumber = mapping.trackingNumber;
    const carrierId = 'kr.cjlogistics';

    if (!trackingNumber) {
      throw new BadRequestException('송장번호가 존재하지 않습니다.');
    }
    const response = await this.deliveryTrackHttp.trackDeliveryDetail(carrierId, trackingNumber);

    const lastEventData = response.data.track.lastEvent
      ? {
        time: response.data.track.lastEvent.time,
        code: response.data.track.lastEvent.status.code,
        name: response.data.track.lastEvent.status.name,
        description: response.data.track.lastEvent.description,
      }
      : null;

    const eventDataList =
      response.data.track.events?.edges?.map((edge) => ({
        time: edge.node.time,
        code: edge.node.status.code,
        name: edge.node.status.name,
        description: edge.node.description,
      })) || [];

    return {
      id: mapping.realProductOrder.id,
      eventName: mapping.realProductOrder.eventName,
      productName: mapping.product.name,
      receiver: mapping.realProductOrder.businessUser?.personName ?? null,
      businessAddress: mapping.realProductOrder.businessUser?.company?.businessAddress ?? '',
      lastEvent: lastEventData?.code ?? null,
      trackingNumber,
      events: eventDataList,
    };
  }

  @Transactional()
  async update(user: ILoginUserInfo, getBody: OrderRealProductUpdateReqDto): Promise<void> {
    const { realProductOrderId, taxInfo, realProductOrderInfo } = getBody;

    let taxMappingIds: number[] = [];
    let productMappingIds: number[] = [];

    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .where('order.id = :id', { id: realProductOrderId });

    if (user.authority === IUserAuthority.CORPORATE_ADMIN) {
      queryBuilder.andWhere('order.businessUserId = :userId', { userId: user.id });
    }

    const order = await queryBuilder.getOne();

    if (!order) {
      throw new BadRequestException('존재하지 않는 주문입니다.');
    }

    if (user.authority === IUserAuthority.CORPORATE_ADMIN && order.status !== IOrderRealProductStatus.ORDER_PENDING) {
      throw new BadRequestException('상품이 수정 가능한 상태가 아닙니다. 수정 요청을 진행해주세요.');
    }

    if (taxInfo) {
      taxMappingIds = taxInfo.map((mapping) => mapping.mappingId);
    }

    if (realProductOrderInfo) {
      productMappingIds = realProductOrderInfo.map((mapping) => mapping.mappingId);
    }

    const allMappingIds = [...new Set([...taxMappingIds, ...productMappingIds])];

    // 전체 매핑 조회 (orderId 포함하여 해당 주문의 매핑만 가져옴)
    const mappings = await this.orderProductMappingRepository.find({
      where: {
        id: In(allMappingIds),
        realProductOrderId, // order 에 속해있는 매핑인지 확인
      },
    });

    if (taxInfo) {
      for (const tax of taxInfo) {
        const mapping = mappings.find((m) => m.id === tax.mappingId);
        if (!mapping) continue;

        mapping.publicChargeTaxPayment = tax.publicChargeTaxPayment;
        mapping.processMethod = tax.processMethod;
        mapping.isProcess = tax.isProcess;
      }
    }

    // 관리자의 송장번호 입력 여부
    let isTrackingUpdated = false;

    if (realProductOrderInfo) {
      for (const real of realProductOrderInfo) {
        const mapping = mappings.find((m) => m.id === real.mappingId);
        if (!mapping) continue;

        if (real.price != null) {
          mapping.price = real.price;
          mapping.totalPrice = calculateRealProductVatIncludedTotal(real.price, mapping.quantity);
        }
        if (real.trackingNumber) {
          mapping.trackingNumber = real.trackingNumber;
          isTrackingUpdated = true;
        }
      }
    }

    // 송장번호 입력시 상태 변경 저장
    if (isTrackingUpdated && order.status === IOrderRealProductStatus.ORDER_PENDING) {
      order.status = IOrderRealProductStatus.ORDER_COMPLETED;
      await this.orderRepository.save(order);
    }

    // 저장
    await this.orderProductMappingRepository.save(mappings);
  }

  async getSettlement(
    user: ILoginUserInfo,
    getQuery: OrderRealProductGetSettlementListReqDto,
  ): Promise<OrderRealProductGetSettlementListResDto> {
    const { eventName, businessName, startAt, personName, endAt, take, page, searchKeyword } = getQuery;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.businessUser', 'businessUser')
      .leftJoinAndSelect('businessUser.company', 'businessCompany')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.orderRealProductMappings', 'orderRealProductMappings')
      .leftJoinAndSelect('orderRealProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand');

    if (searchKeyword) {
      queryBuilder = queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('businessCompany.businessName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('businessUser.personName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('order.eventName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('product.name LIKE :keyword', { keyword: `%${searchKeyword}%` });
        }),
      );
    }

    // 운영 관리자 인 경우
    if (user.authority === IUserAuthority.OPERATION_ADMIN) {
      queryBuilder = queryBuilder.andWhere('order.userId = :userId', { userId: user.id });
    }

    if (businessName) {
      queryBuilder = queryBuilder.andWhere('businessCompany.businessName LIKE :businessName', {
        businessName: `%${businessName}%`,
      });
    }

    if (personName) {
      queryBuilder = queryBuilder.andWhere('businessUser.personName LIKE :personName', {
        personName: `%${personName}%`,
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

    const resultList: OrderRealProductSettleViewDto[] = [];

    for (const order of orderRealProductList) {
      for (const mapping of order.orderRealProductMappings) {
        const product = mapping.product;
        const brand = product.brand;

        // product.price: 상품의 원가 (1개당 원가)
        // mapping.price: 실제 판매가 (관리자가 입력한 실제 판매가)
        // mapping.quantity: 발송 건수 (수량)
        // mapping.totalPrice: 판매가와 부가세를 포함한 총액

        // - 공급금액 = 판매가 * 수량
        // - 부가세 = 판매가 부가세 * 수량
        // - 합계 금액 = 공급금액 + 부가세
        // - 수익액 = 공급금액 - (원가 * 수량)
        // - 수익률 = (수익액 / 공급금액) * 100 (공급금액이 0이면 수익률은 0%)

        const saleTotalPrice = calculateRealProductSupplyTotal(mapping.price, mapping.quantity);
        const tax = calculateRealProductVatTotal(mapping.price, mapping.quantity);
        const totalAmount = calculateRealProductVatIncludedTotal(mapping.price, mapping.quantity);
        const profitAmount = saleTotalPrice - product.price * mapping.quantity; // 수익액
        const profitPercent = saleTotalPrice > 0 ? Math.round((profitAmount / saleTotalPrice) * 100) : 0; // 수익률

        resultList.push({
          id: order.id,
          userBusinessName: order.businessUser.company?.businessName ?? '',
          classification: product.classification?.classification ?? null,
          brandName: brand?.nameKorean || '',
          userPersonName: order.businessUser.personName,
          eventName: order.eventName,
          productName: product.name,
          totalProductCount: mapping.quantity,
          originalPrice: product.price,
          salePrice: mapping.price,
          saleTotalPrice,
          tax,
          totalAmount,
          profitAmount,
          profitPercent,
        });
      }
    }

    return {
      list: resultList,
      currentPage: page,
      totalCount,
      totalPage,
    };
  }

  async getDeliveryCompleteReport(
    getQuery: OrderRealProductGetDeliveryCompleteReportReqDto,
  ): Promise<OrderRealProductGetDeliveryCompleteReportResDto> {
    const { id } = getQuery;

    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.orderRealProductMappings', 'orderRealProductMappings')
      .leftJoinAndSelect('orderRealProductMappings.product', 'product')
      .leftJoinAndSelect('order.businessUser', 'businessUser')
      .leftJoinAndSelect('order.user', 'user')
      .where('order.id = :id', { id });

    const order = await queryBuilder.getOne();

    if (!order) {
      throw new BadRequestException('존재하지 않는 주문 입니다.');
    }

    if (!order.orderRealProductMappings && order.orderRealProductMappings > 0) {
      throw new BadRequestException('주문 상세 정보가 없습니다.');
    }

    const { orderRealProductList, publicChargeTaxList } = buildRealProductAndTaxLists(order.orderRealProductMappings);

    const userInfo: OrderCustomerViewDto = {
      id: order.businessUser?.id ?? null,
      userBusinessName: order.businessUser?.company?.businessName ?? null,
      userPersonPhoneNumber: order.businessUser?.personPhoneNumber ?? null,
      userBusinessEmail: order.businessUser?.email ?? null,
      userPersonName: order.businessUser?.personName ?? null,
      documentCompanyType: order.businessUser?.documentCompanyType ?? CompanyType.ENMAD,
    };
    const now = new Date();
    const today = format(now, 'yyMMdd');
    const fileName: string = `${order.businessUser?.company?.businessName ?? ''}_발송완료리포트_${today}`;

    return {
      id: order.id,
      status: order.status,
      fileName,
      userInfo,
      eventName: order.eventName,
      registerAt: format(order.createdAt, DateFormatStr),
      userBusinessName: order.businessUser ? order.businessUser.company?.businessName ?? null : null,
      userPersonName: order.businessUser ? order.businessUser.personName : null,
      orderRealProductList,
      publicChargeTaxList,
    };
  }

  async settleExcelDownload(user: ILoginUserInfo, getBody: OrderRealProductGetSettlementExcelDownloadReqDto) {
    const startTime = Date.now();
    const now = new Date();
    const nowString = format(now, 'yyyyMMdd');

    const { eventName, businessName, startAt, personName, endAt, password, downloadReason, searchKeyword } = getBody;

    // 비밀번호 검증
    await this.activityLogService.verifyPassword(user.id, password);

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.businessUser', 'businessUser')
      .leftJoinAndSelect('businessUser.company', 'businessCompany')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.orderRealProductMappings', 'orderRealProductMappings')
      .leftJoinAndSelect('orderRealProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand');

    if (searchKeyword) {
      queryBuilder = queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('businessCompany.businessName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('businessUser.personName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('order.eventName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('product.name LIKE :keyword', { keyword: `%${searchKeyword}%` });
        }),
      );
    }

    // 운영 관리자 인 경우
    if (user.authority === IUserAuthority.OPERATION_ADMIN) {
      queryBuilder = queryBuilder.andWhere('order.userId = :userId', { userId: user.id });
    }

    if (businessName) {
      queryBuilder = queryBuilder.andWhere('businessCompany.businessName LIKE :businessName', {
        businessName: `%${businessName}%`,
      });
    }

    if (personName) {
      queryBuilder = queryBuilder.andWhere('businessUser.personName LIKE :personName', {
        personName: `%${personName}%`,
      });
    }

    if (eventName) {
      queryBuilder = queryBuilder.andWhere('order.eventName LIKE :eventName', { eventName: `%${eventName}%` });
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'order', 'createdAt', startAt, endAt);

    const orderRealProductList = await queryBuilder.getMany();

    const resultList: OrderRealProductSettleViewDto[] = [];

    for (const order of orderRealProductList) {
      for (const mapping of order.orderRealProductMappings) {
        const product = mapping.product;
        const brand = product.brand;

        // 현재 정산 정책
        // product.price: 상품의 원가 (1개당 원가)
        // mapping.price: 실제 판매가 (관리자가 입력한 실제 판매가)
        // mapping.quantity: 발송 건수 (수량)
        // mapping.totalPrice: 판매가와 부가세를 포함한 총액

        // - 공급금액 = 판매가 * 수량
        // - 부가세 = 판매가 부가세 * 수량
        // - 합계 금액 = 공급금액 + 부가세
        // - 수익액 = 공급금액 - (원가 * 수량)
        // - 수익률 = (수익액 / 공급금액) * 100 (공급금액이 0이면 수익률은 0%)

        const saleTotalPrice = calculateRealProductSupplyTotal(mapping.price, mapping.quantity);
        const tax = calculateRealProductVatTotal(mapping.price, mapping.quantity);
        const totalAmount = calculateRealProductVatIncludedTotal(mapping.price, mapping.quantity);
        const profitAmount = saleTotalPrice - product.price * mapping.quantity; // 수익액
        const profitPercent = saleTotalPrice > 0 ? Math.round((profitAmount / saleTotalPrice) * 100) : 0; // 수익률

        resultList.push({
          id: order.id,
          userBusinessName: order.businessUser.company?.businessName ?? '',
          classification: product.classification?.classification ?? null,
          brandName: brand?.nameKorean || '',
          userPersonName: order.businessUser.personName,
          eventName: order.eventName,
          productName: product.name,
          totalProductCount: mapping.quantity,
          originalPrice: product.price,
          salePrice: mapping.price,
          saleTotalPrice,
          tax,
          totalAmount,
          profitAmount,
          profitPercent,
        });
      }
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(`sheet1`);

    sheet.columns = [
      { header: '번호', key: 'id', width: 10 },
      { header: '고객사명', key: 'userBusinessName', width: 32 },
      // key 중복
      { header: '대분류', key: 'classification', width: 20 },
      { header: '브랜드명', key: 'brandName', width: 20 },
      { header: '담당자명', key: 'userPersonName', width: 20 },
      { header: '이벤트명', key: 'eventName', width: 32 },
      { header: '상품명', key: 'productName', width: 32 },
      { header: '발송건수', key: 'totalProductCount', width: 32 },
      { header: '원가', key: 'originalPrice', width: 20 },
      { header: '판매가', key: 'salePrice', width: 20 },
      { header: '공급금액', key: 'saleTotalPrice', width: 20 },
      { header: '부가세', key: 'tax', width: 20 },
      { header: '합계금액', key: 'totalAmount', width: 20 },
      { header: '수익액', key: 'profitAmount', width: 20 },
      { header: '수익률 ', key: 'profitPercent', width: 20 },
    ];

    let id = 1;
    for (const result of resultList) {
      sheet.addRow({
        id: id,
        userBusinessName: result.userBusinessName,
        classification: result.classification,
        brandName: result.brandName,
        userPersonName: result.userPersonName,
        eventName: result.eventName,
        productName: result.productName,
        totalProductCount: result.totalProductCount,
        originalPrice: result.originalPrice,
        salePrice: result.salePrice,
        saleTotalPrice: result.saleTotalPrice,
        tax: result.tax,
        totalAmount: result.totalAmount,
        profitAmount: result.profitAmount,
        profitPercent: result.profitPercent,
      });
      id++;
    }

    const fileName = `수익률_조회_기타_정산_${nowString}.xlsx`;
    const filePath = createExportTempPath('xlsx');

    await workbook.xlsx.writeFile(filePath);

    // 성공 로그 저장
    const responseTime = Date.now() - startTime;
    const recordCount = resultList.length;
    const { password: _, ...requestParams } = getBody;

    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/real-product/settle/excel-download',
      actionType: 'EXCEL_DOWNLOAD',
      ipAddress: '',
      userAgent: '',
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime,
      downloadReason,
      recordCount,
      requestParams,
      errorMessage: undefined,
    });

    return { fileName, filePath };
  }

  async excelDownload(user: ILoginUserInfo, getBody: OrderRealProductExcelDownloadReqBodyDto) {
    const startTime = Date.now();
    const { searchType, searchKeyword, status, startAt, endAt, section, password, downloadReason } = getBody;

    // 비밀번호 검증
    await this.activityLogService.verifyPassword(user.id, password);

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

    // 검색 조건 처리 (최소 1자 이상일 때만 검색)
    if (searchKeyword && searchKeyword.length >= 1) {
      switch (searchType) {
        case 'CUSTOMER':
          queryBuilder = queryBuilder.andWhere('businessUser.businessName LIKE :keyword', {
            keyword: `%${searchKeyword}%`,
          });
          break;
        case 'MANAGER':
          queryBuilder = queryBuilder.andWhere('user.personName LIKE :keyword', { keyword: `%${searchKeyword}%` });
          break;
        case 'EVENT':
          queryBuilder = queryBuilder.andWhere('order.eventName LIKE :keyword', { keyword: `%${searchKeyword}%` });
          break;
        case 'PRODUCT':
          queryBuilder = queryBuilder.andWhere('product.name LIKE :keyword', { keyword: `%${searchKeyword}%` });
          break;
        case 'ALL':
        default:
          queryBuilder = queryBuilder.andWhere(
            '(businessUser.businessName LIKE :keyword OR user.personName LIKE :keyword OR order.eventName LIKE :keyword OR product.name LIKE :keyword)',
            { keyword: `%${searchKeyword}%` },
          );
          break;
      }
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'order', 'createdAt', startAt, endAt);

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
        userBusinessName: order.businessUser!.company?.businessName ?? '',
        userName: order.businessUser!.personName,
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
    const filePath = createExportTempPath('xlsx');

    await workbook.xlsx.writeFile(filePath);

    // 성공 로그 저장
    const responseTime = Date.now() - startTime;
    const recordCount = orderList.length;
    const { password: _, ...requestParams } = getBody;

    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/real-product/order/excel-download',
      actionType: 'EXCEL_DOWNLOAD',
      ipAddress: '',
      userAgent: '',
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime,
      downloadReason,
      recordCount,
      requestParams,
      errorMessage: undefined,
    });

    return { fileName, filePath };
  }

  async getOrderProductMappingDetail(
    getParam: OrderRealProductMappingGetDetailReqParamDto,
  ): Promise<OrderRealProductMappingGetDetailResDto> {
    const { id } = getParam;
    const queryBuilder = this.orderProductMappingRepository
      .createQueryBuilder('orderRealProductMapping')
      .innerJoinAndSelect('orderRealProductMapping.realProductOrder', 'realProductOrder')
      .innerJoinAndSelect('realProductOrder.businessUser', 'businessUser')
      .leftJoinAndSelect('orderRealProductMapping.partnerCompany', 'partnerCompany')
      .where('orderRealProductMapping.id = :id', { id });

    const oneOrderProductMapping = await queryBuilder.getOne();
    if (!oneOrderProductMapping) {
      throw new BadRequestException('상품이 존재하지 않습니다.');
    }

    return {
      id: oneOrderProductMapping.id,
      realProductOrderId: oneOrderProductMapping.realProductOrder.id,
      writer: oneOrderProductMapping.writer,
      userId: oneOrderProductMapping.realProductOrder.businessUserId,
      userBusinessName: oneOrderProductMapping.realProductOrder.businessUser?.company?.businessName ?? '',
      eventName: oneOrderProductMapping.realProductOrder.eventName,
      partnerCompanyId: oneOrderProductMapping.partnerCompanyId,
      partnerCompanyName: oneOrderProductMapping.partnerCompany?.businessName ?? null,
      buyMethod: oneOrderProductMapping.buyMethod,
      offlineAddress: oneOrderProductMapping.offlineAddress,
      offlinePersonName: oneOrderProductMapping.offlinePersonName,
      offlinePhoneNumber: oneOrderProductMapping.offlinePhoneNumber,
      receivingMethod: oneOrderProductMapping.receivingMethod,
      trackingNumber: oneOrderProductMapping.trackingNumber,
      paymentMethod: oneOrderProductMapping.paymentMethod,
      paymentBank: oneOrderProductMapping.realProductOrder.businessUser.bankName,
      paymentAccountInfo: oneOrderProductMapping.realProductOrder.businessUser.bankNumber,
      remarks: oneOrderProductMapping.remarks,
      progressStatus: oneOrderProductMapping.progressStatus,
      filePath: oneOrderProductMapping.filePath,
    };
  }

  async updateOrderProductMappingDetail(getBody: OrderRealProductMappingUpdateReqDto) {
    const {
      id,
      writer,
      buyMethod,
      offlineAddress,
      offlinePhoneNumber,
      offlinePersonName,
      receivingMethod,
      trackingNumber,
      paymentMethod,

      remarks,
      progressStatus,
      filePath,
      partnerCompanyId,
    } = getBody;

    const queryBuilder = this.orderProductMappingRepository
      .createQueryBuilder('orderRealProductMapping')
      .where('orderRealProductMapping.id = :id', { id });

    const oneOrderProductMapping = await queryBuilder.getOne();
    if (!oneOrderProductMapping) {
      throw new BadRequestException('상품이 존재하지 않습니다.');
    }

    oneOrderProductMapping.id = id;

    oneOrderProductMapping.partnerCompanyId = partnerCompanyId;
    oneOrderProductMapping.writer = writer;

    oneOrderProductMapping.buyMethod = buyMethod;
    oneOrderProductMapping.offlineAddress = offlineAddress;
    oneOrderProductMapping.offlinePersonName = offlinePersonName;
    oneOrderProductMapping.offlinePhoneNumber = offlinePhoneNumber;
    oneOrderProductMapping.receivingMethod = receivingMethod;
    oneOrderProductMapping.trackingNumber = trackingNumber;
    oneOrderProductMapping.paymentMethod = paymentMethod;

    oneOrderProductMapping.remarks = remarks;
    oneOrderProductMapping.progressStatus = progressStatus;
    oneOrderProductMapping.filePath = filePath;

    await this.orderProductMappingRepository.save(oneOrderProductMapping);
    return;
  }
}
