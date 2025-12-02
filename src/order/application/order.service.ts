import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  Query,
} from '@nestjs/common';
import { UserManagementService } from '../../user_management/application/user.management.service';
import { SsgEventService } from '../../ssg_event/application/ssg.event.service';
import {
  OrderCreateSettleReqDto,
  OrderCreateTempReqDto,
  OrderDeleteTempReqDto,
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
  OrderGetPreviousContentReqQueryDto,
  OrderGetSettleReqDto,
  OrderTestDeliveryReqDto,
  OrderUpdateOperationUserReqDto,
  OrderUpdateSettleReqDto,
  OrderUpdateTempReqDto,
  OrderUpdateEncourageDayReqBodyDto,
} from '../api/order.req.dto';
import {
  OrderCreateTempResDto,
  OrderDeliveryConfirmed,
  OrderGetDeliveryCompleteReportResDto,
  OrderGetDetailResDto,
  OrderGetListResDto,
  OrderGetMyOrderHistoryResDto,
  OrderGetOrderCompleteReportResDto,
  OrderGetPreviousContentResDto,
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
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { PhoneUtil } from '../../common/utils/phone.util';
import { DeliveryBatchService } from '../../delivery/application/delivery.batch.service';
import { IOrderSendMethod } from '../interface/order.send.method';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

@Injectable()
export class OrderService {
  private logger = new Logger('OrderService');
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
    private readonly userManagementService: UserManagementService,
    private readonly ssgEventService: SsgEventService,
    private readonly cryptoCipher: CryptoCipher,

    // @Inject('DeliveryAlimTalk')
    // private deliveryAlimTalk: DeliveryAlimTalk,
    // @Inject('IMailSend')
    // private mailSend: IMailSend,
    // @Inject('ISmsSend')
    // private smsSend: ISmsSend,
    // private configService: ConfigService,
    // @InjectRepository(EmailSendHistoryEntity)
    // private emailSendHistoryRepository: Repository<EmailSendHistoryEntity>,
    // @Inject('IFileStorage')
    // private fileStorage: IFileStorage,
    private deliveryBatchService: DeliveryBatchService,
    private activityLogService: ActivityLogService,
  ) {}

  async getList(user: ILoginUserInfo, getQuery: OrderGetListReqDto): Promise<OrderGetListResDto> {
    const { section, type, status, startAt, endAt, searchType, searchKeyword, page, take } = getQuery;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
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

    // 검색 조건 처리 (최소 1자 이상일 때만 검색)
    if (searchKeyword && searchKeyword.length >= 1) {
      switch (searchType) {
        case 'CUSTOMER':
          queryBuilder = queryBuilder.andWhere('user.businessName LIKE :keyword', { keyword: `%${searchKeyword}%` });
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
            '(user.businessName LIKE :keyword OR operationUser.personName LIKE :keyword OR order.eventName LIKE :keyword OR product.name LIKE :keyword)',
            { keyword: `%${searchKeyword}%` },
          );
          break;
      }
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'order', 'registerAt', startAt, endAt);

    queryBuilder = queryBuilder.orderBy('order.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.take(take).skip(skip);
    const [orderList, totalCount] = await queryBuilder.getManyAndCount();
    const totalPage = Math.ceil(totalCount / take);

    const resultList: OrderViewDto[] = orderList.map((order) => {
      let totalAmount = 0;
      let totalProductCount = 0;
      let productName = '';
      let actualSendAt: string | null = null;

      if (order.orderProductMappings && order.orderProductMappings.length > 0) {
        totalAmount = order.orderProductMappings.reduce((acc, cur) => {
          return acc + cur.amount;
        }, 0);
        totalProductCount = order.orderProductMappings.length;
        const firstProduct = order.orderProductMappings[0].product;
        productName = firstProduct ? firstProduct.name : '(삭제된 상품)';
        const orderProductMappingsLength = order.orderProductMappings.length;
        if (orderProductMappingsLength - 1 > 0) {
          productName += `외 ${orderProductMappingsLength - 1}건`;
        }

        // 실제 발송 시간: 발송 완료 상태일 때만 orderDelivery의 actualSendAt 사용
        const firstDelivery = order.orderProductMappings[0].orderDeliveries?.[0];
        if (
          firstDelivery &&
          (firstDelivery.status === IOrderDeliveryStatus.COMPLETE ||
            firstDelivery.status === IOrderDeliveryStatus.COMPLETE_SMS) &&
          firstDelivery.actualSendAt
        ) {
          actualSendAt = format(firstDelivery.actualSendAt, DateFormatStr);
        }
      }

      // 첫 번째 상품의 발송 정보 사용
      const firstMapping = order.orderProductMappings?.[0];
      const sendRequestAt =
        firstMapping && normalizeDate(firstMapping.sendRequestAt)
          ? format(firstMapping.sendRequestAt!, DateFormatStr)
          : null;

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
        actualSendAt: actualSendAt,
        operationUserId: order.operationUserId,
        operationUserName: order.operationUser?.personName ?? null,
        deliveryPrice: order.sendAmount,
        settlePrice: order.settleAmount,
        requestToDestroyPersonalInfoDay: firstMapping?.requestToDestroyPersonalInfoDay ?? 0,
        sendType: firstMapping?.sendType ?? null,
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
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .where('order.id = :id', { id: getParam.id });

    const order = await queryBuilder.getOne();

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    const user = await this.userRepository.findOne({
      where: {
        id: order.userId,
      },
    });

    if (!user) {
      throw new InternalServerErrorException('');
    }

    const productList: OrderDetailProductDto[] = [];

    let topImagePath;
    let midImagePath;

    if (order.orderProductMappings && order.orderProductMappings.length > 0) {
      for (const orderProductMapping of order.orderProductMappings) {
        const orderDeliveryList: OrderViewDeliveryDto[] = [];
        const productExpireDay = orderProductMapping.product.expireDay;
        const validityStartsNextDay = orderProductMapping.product.partnerCompany?.validityStartsNextDay ?? true;
        const expireDay = validityStartsNextDay ? productExpireDay : productExpireDay - 1;

        const expireDate = expireDay ? dayjs().tz('Asia/Seoul').add(expireDay, 'day').format('YYYY. MM. DD') : null;
        for (const orderDelivery of orderProductMapping.orderDeliveries) {
          // deliveryTarget 복호화
          let decryptedDeliveryTarget = orderDelivery.deliveryTarget;
          if (orderDelivery.deliveryTarget) {
            try {
              decryptedDeliveryTarget = this.cryptoCipher.decryptDeliveryTarget(orderDelivery.deliveryTarget);
            } catch (error) {
              // 복호화 실패 시 원본 데이터 사용
              decryptedDeliveryTarget = orderDelivery.deliveryTarget;
            }
          }

          orderDeliveryList.push({
            id: orderDelivery.id,
            deliveryTarget: decryptedDeliveryTarget,
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
              expireDate: expireDate,
              amount: orderProductMapping.amount,
              imagePath: orderProductMapping.product.imagePath,
              brandId: orderProductMapping.product.brandId,
              brandName: orderProductMapping.product.brand?.nameKorean ?? '',
            }
          : null;

        if (!product) {
          continue;
        }

        productList.push({
          id: orderProductMapping.id,
          product: product,
          orderDeliveryList: orderDeliveryList,

          emailSendType: orderProductMapping.emailSendType,
          fromEmail: orderProductMapping.fromEmail,
          fromPhoneNumber: orderProductMapping.fromPhoneNumber,
          requestToDestroyPersonalInfoDay: orderProductMapping.requestToDestroyPersonalInfoDay,
          sendContent: orderProductMapping.sendContent ?? '',
          sendMethod: orderProductMapping.sendMethod!,
          sendRequestAt: orderProductMapping.sendRequestAt
            ? format(orderProductMapping.sendRequestAt, DateFormatStr)
            : null,
          sendTailText: orderProductMapping.sendTailText,
          sendTitle: orderProductMapping.sendTitle ?? '',
          sendType: orderProductMapping.sendType,
          useEmailContent: orderProductMapping.useEmailContent,
          encourageDay: orderProductMapping.encourageDay,
        });
      }
    }

    let couponExpiration: number | null = null;
    if (order.type === IOrderType.SSG) {
      couponExpiration = productList[0].product?.expireDay ?? null;
    }

    return {
      id: order.id,
      registerAt: format(order.registerAt, DateFormatStr),
      eventName: order.eventName,
      type: order.type,
      topImagePath,
      midImagePath,
      status: order.status,
      couponExpiration: couponExpiration,
      productList: productList,
      settlePeriodCondition: user.settlePeriodCondition,
      settlePeriodCount: user.settlePeriodCount,
    };
  }

  // 이벤트 불러오기 전용 메서드 (수신자 정보 제외)
  async getEventDetail(getParam: OrderGetDetailReqParamDto): Promise<OrderGetDetailResDto> {
    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
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
        const productExpireDay = orderProductMapping.product.expireDay;
        const validityStartsNextDay = orderProductMapping.product.partnerCompany?.validityStartsNextDay ?? true;
        const expireDay = validityStartsNextDay ? productExpireDay : productExpireDay - 1;

        const expireDate = expireDay ? dayjs().tz('Asia/Seoul').add(expireDay, 'day').format('YYYY. MM. DD') : null;
        topImagePath = orderProductMapping.topImagePath ?? OrderService.DEFAULT_TOP_IMAGE_PATH;
        midImagePath = orderProductMapping.midImagePath ?? OrderService.DEFAULT_MID_IMAGE_PATH;

        const product = orderProductMapping.product
          ? {
              id: orderProductMapping.product.id,
              name: orderProductMapping.product.name,
              price: orderProductMapping.product.price,
              expireDay: orderProductMapping.product.expireDay,
              expireDate: expireDate,
              amount: orderProductMapping.amount,
              imagePath: orderProductMapping.product.imagePath,
              brandId: orderProductMapping.product.brandId,
              brandName: orderProductMapping.product.brand?.nameKorean ?? '',
            }
          : null;

        if (!product) {
          continue;
        }

        productList.push({
          id: orderProductMapping.id,
          product: product,
          orderDeliveryList: [], // 이벤트 불러오기 시 수신자 정보는 빈 배열

          emailSendType: orderProductMapping.emailSendType,
          fromEmail: orderProductMapping.fromEmail,
          fromPhoneNumber: orderProductMapping.fromPhoneNumber,
          requestToDestroyPersonalInfoDay: orderProductMapping.requestToDestroyPersonalInfoDay,
          sendContent: orderProductMapping.sendContent ?? '',
          sendMethod: orderProductMapping.sendMethod!,
          sendRequestAt: orderProductMapping.sendRequestAt
            ? format(orderProductMapping.sendRequestAt, DateFormatStr)
            : null,
          sendTailText: orderProductMapping.sendTailText,
          sendTitle: orderProductMapping.sendTitle ?? '',
          sendType: orderProductMapping.sendType,
          useEmailContent: orderProductMapping.useEmailContent,
          encourageDay: orderProductMapping.encourageDay,
        });
      }
    }

    let couponExpiration: number | null = null;
    if (order.type === IOrderType.SSG) {
      couponExpiration = productList[0].product?.expireDay ?? null;
    }

    return {
      id: order.id,
      registerAt: format(order.registerAt, DateFormatStr),
      eventName: order.eventName,
      type: order.type,
      topImagePath,
      midImagePath,
      status: order.status,
      couponExpiration: couponExpiration,
      productList: productList,
      settlePeriodCondition: order.user!.settlePeriodCondition,
      settlePeriodCount: order.user!.settlePeriodCount,
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
        const productExpireDay = orderProductMapping.product.expireDay || 0;
        const validityStartsNextDay = orderProductMapping.product.partnerCompany?.validityStartsNextDay ?? true;
        const expireDay = validityStartsNextDay ? productExpireDay : productExpireDay - 1;

        const expireDate = expireDay ? dayjs().tz('Asia/Seoul').add(expireDay, 'day').format('YYYY. MM. DD') : null;

        for (const orderDelivery of orderProductMapping.orderDeliveries) {
          // deliveryTarget 복호화 후 마스킹 처리
          let decryptedDeliveryTarget = orderDelivery.deliveryTarget;
          if (orderDelivery.deliveryTarget) {
            try {
              decryptedDeliveryTarget = this.cryptoCipher.decryptDeliveryTarget(orderDelivery.deliveryTarget);
            } catch (error) {
              // 복호화 실패 시 원본 데이터 사용
              decryptedDeliveryTarget = orderDelivery.deliveryTarget;
            }
          }

          orderDeliveryList.push({
            id: orderDelivery.id,
            sendRequestAt: orderDelivery.sendRequestAt ? format(orderDelivery.sendRequestAt, DateFormatStr) : null,
            productName: orderProductMapping.product.name ?? null,
            amount: orderProductMapping.product.price ?? null,
            barCode: orderDelivery.barCode ? maskBarCode(orderDelivery.barCode) : null,
            deliveryMethod: orderDelivery.deliveryMethod,
            deliveryTarget:
              orderProductMapping.sendMethod !== 'EMAIL'
                ? maskBarCode(decryptedDeliveryTarget)
                : decryptedDeliveryTarget,
          });
        }

        const product = orderProductMapping.product
          ? {
              id: orderProductMapping.product.id,
              name: orderProductMapping.product.name,
              price: orderProductMapping.product.price,
              expireDay: orderProductMapping.product.expireDay,
              amount: orderProductMapping.amount,
              expireDate: expireDate,
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

    let couponExpiration: number | null = null;
    if (order.type === IOrderType.SSG) {
      couponExpiration = productList[0].product?.expireDay ?? null;
    }

    // 첫 번째 상품의 정보 사용
    const firstMapping = order.orderProductMappings?.[0];

    return {
      id: order.id,
      fileName,
      userInfo,
      registerAt: format(order.registerAt, DateFormatStr),
      eventName: order.eventName,
      type: order.type,
      status: order.status,
      couponExpiration: couponExpiration,
      requestToDestroyPersonalInfoDay: firstMapping?.requestToDestroyPersonalInfoDay ?? 0,
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

        // 상품별로 한 줄만 추가 (첫 번째 orderDelivery의 발송 시각 사용)
        const firstDelivery = orderProductMapping.orderDeliveries?.[0];
        orderDeliveryList.push({
          id: orderProductMapping.id, // orderProductMapping id 사용
          sendRequestAt: firstDelivery?.sendRequestAt ? format(firstDelivery.sendRequestAt, DateFormatStr) : null,
          productName: orderProductMapping.product.name ?? null,
          quantity, // 수량
          unitPrice: productPrice, // 단가
          price: total, // 공급가액 (단가 * 수량)
        });
      }

      vat = Math.floor(price * 0.1);
      totalAmount = price + vat;
    }

    // 첫 번째 상품의 발송 요청 시간 사용
    const firstMapping = order.orderProductMappings?.[0];
    const sendRequestAt =
      firstMapping && normalizeDate(firstMapping.sendRequestAt)
        ? format(firstMapping.sendRequestAt!, DateFormatStr)
        : null;

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
    const oneUserId = existingOrderProducts[0].order.userId;
    const sendAmount = existingOrderProducts[0].order.sendAmount;
    const isSettleBalance = existingOrderProducts[0].order.isSettleBalance;
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

    const oneUser = await this.userRepository.findOneOrFail({
      where: {
        id: oneUserId,
      },
    });

    if (isSettleBalance) {
      oneUser.balance = oneUser.balance + sendAmount - (settleAmount + settleFee);
    } else {
      oneUser.allSettleAmount = oneUser.allSettleAmount - sendAmount + (settleAmount + settleFee);
    }

    await this.userRepository.save(oneUser);
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
    const oneUserId = existingOrderProducts[0].order.userId;

    const beforeSettleAmount = existingOrderProducts[0].order.settleAmount;
    const isSettleBanace = existingOrderProducts[0].order.isSettleBalance;
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

    const oneUser = await this.userRepository.findOneOrFail({
      where: {
        id: oneUserId,
      },
    });

    if (isSettleBanace) {
      oneUser.balance = oneUser.balance + beforeSettleAmount - (settleAmount + settleFee);
    } else {
      oneUser.allSettleAmount = oneUser.allSettleAmount - beforeSettleAmount + (settleAmount + settleFee);
    }

    await this.userRepository.save(oneUser);
  }

  @Transactional()
  async createTemp(user: ILoginUserInfo, getBody: OrderCreateTempReqDto): Promise<OrderCreateTempResDto> {
    const { type, eventName, topImagePath, midImagePath, orderProductList } = getBody;

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
      withDeleted: true,
    });

    const prevCode = prevProduct?.code ?? null;

    const newCode = CreateCode(prevCode, OrderPrefixCode, OrderDigitNumber);

    for (const orderProduct of orderProductList) {
      const getProduct = productPriceMap.get(orderProduct.productId)!;
      sendAmount += getProduct.price * orderProduct.amount;
    }

    // 첫 번째 상품의 sendType으로 즉시발송 여부 판단
    const firstProduct = orderProductList[0];
    const isImmediate = firstProduct?.sendType === 'IMMEDIATE';
    const defaultSendAt = isImmediate
      ? new Date()
      : firstProduct?.sendRequestAt
        ? new Date(firstProduct.sendRequestAt)
        : (() => {
            throw new BadRequestException('sendRequestAt 누락');
          })();

    const orderInsertResult = await this.orderRepository.insert({
      userId: user.id,
      status: IOrderStatus.TEMP,
      code: newCode,
      type,
      eventName,
      sendAmount: sendAmount,
      settleAmount: sendAmount,
      registerAt: new Date(),
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

      const isProductImmediate = product.sendType === 'IMMEDIATE';
      const productSendAt = isProductImmediate
        ? new Date()
        : product.sendRequestAt
          ? new Date(product.sendRequestAt)
          : defaultSendAt;

      orderProduct.sendMethod = product.sendMethod;
      orderProduct.sendTailText = product.sendTailText;
      orderProduct.requestToDestroyPersonalInfoDay = product.requestToDestroyPersonalInfoDay;
      orderProduct.fromPhoneNumber = product.fromPhoneNumber;
      orderProduct.fromEmail = product.fromEmail;
      orderProduct.sendTitle = product.sendTitle;
      orderProduct.emailSendType = product.emailSendType;
      orderProduct.useEmailContent = product.useEmailContent;
      orderProduct.sendContent = product.sendContent;
      orderProduct.sendRequestAt = productSendAt;
      orderProduct.sendType = product.sendType;
      orderProduct.encourageDay = product.encourageDay ?? null;

      await this.orderProductMappingRepository.save(orderProduct);

      // 상품별 발신 수단 사용
      const deliverySendMethod = orderProduct.sendMethod!;

      for (const orderDelivery of product.orderDeliveryList) {
        const oneOrderDelivery = new OrderDeliveryEntity();
        oneOrderDelivery.orderProductMappingId = orderProduct.id;
        oneOrderDelivery.status = IOrderDeliveryStatus.TEMP;
        oneOrderDelivery.deliveryMethod = deliverySendMethod;
        oneOrderDelivery.deliveryTarget = this.cryptoCipher.encryptDeliveryTarget(
          PhoneUtil.normalizeDeliveryTarget(orderDelivery.deliveryTarget),
        );
        oneOrderDelivery.replaceCharacter1 = orderDelivery.replaceCharacter1 ?? null;
        oneOrderDelivery.replaceCharacter2 = orderDelivery.replaceCharacter2 ?? null;
        oneOrderDelivery.replaceCharacter3 = orderDelivery.replaceCharacter3 ?? null;
        oneOrderDelivery.sendRequestAt = productSendAt;
        orderDeliveryCreateList.push(oneOrderDelivery);
      }
    }

    await this.orderDeliveryRepository.insert(orderDeliveryCreateList);

    return { id: orderId };
  }

  @Transactional()
  async updateTemp(user: ILoginUserInfo, getBody: OrderUpdateTempReqDto): Promise<void> {
    const { id, eventName, topImagePath, midImagePath, orderProductList } = getBody;

    const order = await this.orderRepository.findOne({
      where: {
        id: id,
        // userId: user.id,
        // status: IOrderStatus.TEMP,
      },
    });

    if (!order) {
      throw new BadRequestException('존재하지 않는 주문입니다.');
    }

    // 최고 관리자 외 타 유저 주문 수정 불가능
    if (user.authority !== IUserAuthority.SUPER_ADMIN && order.userId !== user.id) {
      throw new ForbiddenException('타 유저의 주문입니다.');
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

    // 첫 번째 상품의 sendType으로 즉시발송 여부 판단
    const firstProduct = orderProductList[0];
    const isImmediate = firstProduct?.sendType === 'IMMEDIATE';
    const defaultSendAt = isImmediate
      ? new Date()
      : firstProduct?.sendRequestAt
        ? new Date(firstProduct.sendRequestAt)
        : (() => {
            throw new BadRequestException('sendRequestAt 누락');
          })();

    order.eventName = eventName;
    order.sendAmount = sendAmount;
    order.settleAmount = sendAmount;

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

      const isProductImmediate = product.sendType === 'IMMEDIATE';
      const productSendAt = isProductImmediate
        ? new Date()
        : product.sendRequestAt
          ? new Date(product.sendRequestAt)
          : defaultSendAt;

      orderProduct.sendMethod = product.sendMethod;
      orderProduct.sendTailText = product.sendTailText;
      orderProduct.requestToDestroyPersonalInfoDay = product.requestToDestroyPersonalInfoDay;
      orderProduct.fromPhoneNumber = product.fromPhoneNumber;
      orderProduct.fromEmail = product.fromEmail;
      orderProduct.sendTitle = product.sendTitle;
      orderProduct.emailSendType = product.emailSendType;
      orderProduct.useEmailContent = product.useEmailContent;
      orderProduct.sendContent = product.sendContent;
      orderProduct.sendRequestAt = productSendAt;
      orderProduct.sendType = product.sendType;
      orderProduct.encourageDay = product.encourageDay ?? null;

      await this.orderProductMappingRepository.save(orderProduct);

      // 상품별 발신 수단 사용
      const deliverySendMethod = orderProduct.sendMethod!;

      for (const orderDelivery of product.orderDeliveryList) {
        const oneOrderDelivery = new OrderDeliveryEntity();
        oneOrderDelivery.orderProductMappingId = orderProduct.id;
        oneOrderDelivery.status = IOrderDeliveryStatus.TEMP;
        oneOrderDelivery.deliveryMethod = deliverySendMethod;
        oneOrderDelivery.deliveryTarget = this.cryptoCipher.encryptDeliveryTarget(
          PhoneUtil.normalizeDeliveryTarget(orderDelivery.deliveryTarget),
        );
        oneOrderDelivery.replaceCharacter1 = orderDelivery.replaceCharacter1 ?? null;
        oneOrderDelivery.replaceCharacter2 = orderDelivery.replaceCharacter2 ?? null;
        oneOrderDelivery.replaceCharacter3 = orderDelivery.replaceCharacter3 ?? null;
        oneOrderDelivery.sendRequestAt = productSendAt;
        orderDeliveryCreateList.push(oneOrderDelivery);
      }
    }

    await this.orderDeliveryRepository.insert(orderDeliveryCreateList);

    return;
  }

  @Transactional()
  async deleteTemp(user: ILoginUserInfo, getBody: OrderDeleteTempReqDto): Promise<void> {
    const { id } = getBody;

    // 1. 주문 존재 여부와 TEMP 상태 확인
    const order = await this.orderRepository.findOne({
      where: {
        id: id,
        userId: user.id,
        status: IOrderStatus.TEMP,
      },
    });

    if (!order) {
      throw new BadRequestException('존재하지 않거나 임시저장 상태가 아닌 주문입니다.');
    }

    // 2. 주문 자체 soft delete (deleted_at에 now() 기록)
    await this.orderRepository.softDelete({ id });

    // 3. 연관된 자식 테이블 soft delete
    // 3-1. order_product_mapping
    const mappingList = await this.orderProductMappingRepository.find({
      where: { orderId: id },
    });

    if (mappingList.length > 0) {
      const mappingIds = mappingList.map((mp) => mp.id);

      // 3-2. order_delivery soft delete
      await this.orderDeliveryRepository.softDelete({
        orderProductMappingId: In(mappingIds),
      });

      // 3-3. order_product_mapping soft delete
      await this.orderProductMappingRepository.softDelete({
        id: In(mappingIds),
      });
    }

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

    // 총 주문 금액
    const totalAmount = order.orderProductMappings.reduce((sum, m) => {
      if (!m.product) {
        throw new BadRequestException('상품 정보가 존재하지 않습니다.');
      }
      return sum + m.product.price * m.amount;
    }, 0);
    this.logger.debug(`User#${user.id} totalAmount=${totalAmount}`);

    // 유저 잔액 조회
    const userBalance = await this.userManagementService.getBalance(user.id);
    this.logger.debug(`User#${user.id} balance=${userBalance}`);

    const oneUser = await this.userRepository.findOne({ where: { id: user.id } });
    if (!oneUser) {
      throw new InternalServerErrorException('유저가 존재하지 않습니다.');
    }

    // allSettleAmount 해당 유저의 전체 order 사용 금액
    // balance -> 선충전 금액
    // maximumLimit -> 최대 서비스 한도
    const remainServiceAmount =
      oneUser.maximumLimit + oneUser.balance - oneUser.allSettleAmount + oneUser.serviceAmount;

    // 잔액 부족 시 예외
    // if (totalAmount > userBalance) {
    //   throw new BadRequestException('잔액이 부족하여 발송 요청할 수 없습니다.');
    // }

    if (totalAmount > remainServiceAmount) {
      throw new BadRequestException('최대 서비스 한도를 넘어 요청할 수 없습니다.');
    }

    // ======== 중복번호 제어 체크 시작 ========
    if (oneUser.duplicatePhoneLimit > 0) {
      this.logger.debug(`중복번호 제어 활성화: limit=${oneUser.duplicatePhoneLimit}`);

      // 오늘 날짜 범위 계산 (00:00:00 ~ 23:59:59)
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      // user_discount 조회 (유저별 또는 협력사별 할인 규칙)
      const userDiscounts = await this.userDiscountRepository.find({
        where: [
          { userId: user.id },
          { partnerCompanyId: In(order.orderProductMappings!.map((m) => m.product!.partnerCompanyId)) },
        ],
      });

      this.logger.debug(
        `조회된 user_discount 개수: ${userDiscounts.length}, 내용: ${JSON.stringify(
          userDiscounts.map((d) => ({
            id: d.id,
            category: d.category,
            primaryCategory: d.primaryCategory,
            group: d.group,
            priceAdjustment: d.priceAdjustment,
            pricePercent: d.pricePercent,
          })),
        )}`,
      );

      for (const orderMapping of order.orderProductMappings!) {
        this.logger.debug(
          `상품 ${orderMapping.productId} 정보: category=${orderMapping.product?.category}, classification=${orderMapping.product?.classification}, fee=${orderMapping.fee}, priceAdjustment=${orderMapping.priceAdjustment}`,
        );

        // 할인이 적용된 상품만 체크
        // orderMapping.fee가 아직 설정되지 않았을 수 있으므로, user_discount와 product를 비교해서 판단
        let hasDiscount = false;
        let discountPercent = 0;

        // 1. orderMapping에 이미 fee와 priceAdjustment가 설정되어 있는 경우
        if (
          orderMapping.fee !== null &&
          orderMapping.fee !== undefined &&
          orderMapping.priceAdjustment === 'DISCOUNT'
        ) {
          hasDiscount = orderMapping.fee > 0;
          discountPercent = orderMapping.fee;
          this.logger.debug(`상품 ${orderMapping.productId}: 기존 fee/priceAdjustment로 할인 적용 확인됨`);
        }
        // 2. 설정되지 않은 경우, user_discount에서 찾기
        else {
          for (const discount of userDiscounts) {
            // CATEGORY 방식: group(상품군)과 상품의 category 비교
            if (discount.category === 'CATEGORY' && discount.group === orderMapping.product!.category) {
              if (discount.priceAdjustment === 'DISCOUNT') {
                hasDiscount = true;
                discountPercent = discount.pricePercent;
                this.logger.debug(
                  `상품 ${orderMapping.productId}: CATEGORY 매칭됨 (discount.group=${discount.group}, product.category=${orderMapping.product!.category})`,
                );
                break;
              }
            }
            // CLASSIFICATION 방식: primaryCategory(대분류)와 상품의 classification 비교
            else if (
              discount.category === 'CLASSIFICATION' &&
              discount.primaryCategory === orderMapping.product!.classification?.classification
            ) {
              if (discount.priceAdjustment === 'DISCOUNT') {
                hasDiscount = true;
                discountPercent = discount.pricePercent;
                this.logger.debug(
                  `상품 ${orderMapping.productId}: CLASSIFICATION 매칭됨 (discount.primaryCategory=${discount.primaryCategory}, product.classification=${orderMapping.product!.classification})`,
                );
                break;
              }
            }
          }
        }

        if (!hasDiscount) {
          this.logger.debug(`상품 ${orderMapping.productId}: 할인 미적용, 중복 체크 스킵`);
          continue;
        }

        this.logger.debug(`상품 ${orderMapping.productId}: 할인 적용됨 (${discountPercent}%), 중복 체크 시작`);

        // ======== 현재 주문 내 중복 체크 ========
        const currentOrderPhoneCount = new Map<string, number>(); // key: deliveryTarget, value: count

        for (const od of orderMapping.orderDeliveries) {
          const phone = od.deliveryTarget;
          currentOrderPhoneCount.set(phone, (currentOrderPhoneCount.get(phone) || 0) + 1);
        }

        // 모든 중복 에러를 수집
        const duplicateErrors: string[] = [];

        // 현재 주문 내에서 중복된 수신처가 limit를 초과하는지 체크
        // duplicatePhoneLimit: 허용되는 중복 개수 (총 허용 개수 = limit + 1)
        // 예: limit=1이면 1개 중복 허용, 즉 총 2건까지 가능
        for (const [phone, count] of currentOrderPhoneCount.entries()) {
          if (count > oneUser.duplicatePhoneLimit + 1) {
            // 에러 메시지에 표시할 평문 복호화
            let displayPhone = phone;
            try {
              displayPhone = this.cryptoCipher.decryptDeliveryTarget(phone);
            } catch (error) {
              // 복호화 실패 시 원본 사용
            }

            duplicateErrors.push(`- ${displayPhone}: 현재 주문에 ${count}건 포함`);
          }
        }

        // ======== 기존 주문과 중복 체크 ========
        // 각 고유 수신처에 대해 기존 주문과 현재 주문을 합쳐서 체크
        for (const [phone, currentCount] of currentOrderPhoneCount.entries()) {
          // 에러 메시지와 로그에 표시할 평문 복호화
          let displayPhone = phone;
          try {
            displayPhone = this.cryptoCipher.decryptDeliveryTarget(phone);
          } catch (error) {
            // 복호화 실패 시 원본 사용
          }

          // 신세계 특별 케이스: 동일 이벤트 + 동일 상품 중복 체크
          if (order.type === IOrderType.SSG) {
            // 같은 이벤트, 같은 상품, 같은 수신처로 이미 주문이 있는지 확인
            const sameEventOrderCount = await this.orderDeliveryRepository
              .createQueryBuilder('od')
              .innerJoin('od.orderProductMapping', 'opm')
              .innerJoin('opm.order', 'o')
              .where('o.userId = :userId', { userId: user.id })
              .andWhere('o.eventName = :eventName', { eventName: order.eventName })
              .andWhere('opm.productId = :productId', { productId: orderMapping.productId })
              .andWhere('od.deliveryTarget = :deliveryTarget', { deliveryTarget: phone })
              .andWhere('o.status IN (:...statuses)', {
                statuses: [
                  IOrderStatus.DELIVERY_REQUEST,
                  IOrderStatus.DELIVERY_CONFIRMED,
                  IOrderStatus.DELIVERY_COMPLETE,
                ],
              })
              .andWhere('o.createdAt >= :todayStart', { todayStart })
              .andWhere('o.createdAt <= :todayEnd', { todayEnd })
              .getCount();

            if (sameEventOrderCount > 0) {
              duplicateErrors.push(`- ${displayPhone}: 동일 이벤트에서 이미 발송됨 (합산하여 입력 필요)`);
            }
          }

          // 일반 중복 체크: 하루 기준 동일상품 동일수신처 발송 횟수
          const existingCount = await this.orderDeliveryRepository
            .createQueryBuilder('od')
            .innerJoin('od.orderProductMapping', 'opm')
            .innerJoin('opm.order', 'o')
            .where('o.userId = :userId', { userId: user.id })
            .andWhere('opm.productId = :productId', { productId: orderMapping.productId })
            .andWhere('od.deliveryTarget = :deliveryTarget', { deliveryTarget: phone })
            .andWhere('o.status IN (:...statuses)', {
              statuses: [
                IOrderStatus.DELIVERY_REQUEST,
                IOrderStatus.DELIVERY_CONFIRMED,
                IOrderStatus.DELIVERY_COMPLETE,
              ],
            })
            .andWhere('o.createdAt >= :todayStart', { todayStart })
            .andWhere('o.createdAt <= :todayEnd', { todayEnd })
            .getCount();

          const totalCount = existingCount + currentCount;
          const allowedCount = oneUser.duplicatePhoneLimit + 1;

          this.logger.debug(
            `중복 체크 결과: 상품=${orderMapping.productId}, 수신처=${displayPhone}, 기존=${existingCount}, 현재=${currentCount}, 합계=${totalCount}, 허용=${allowedCount}`,
          );

          if (totalCount > allowedCount) {
            duplicateErrors.push(
              `- ${displayPhone}: 금일 ${existingCount}건 발송 + 현재 ${currentCount}건 = 총 ${totalCount}건`,
            );
          }
        }

        // 중복 에러가 있으면 모두 표시
        if (duplicateErrors.length > 0) {
          const allowedCount = oneUser.duplicatePhoneLimit + 1;
          throw new BadRequestException(
            `중복발송 제한(총 ${allowedCount}건까지 허용)을 초과한 수신처가 ${duplicateErrors.length}건 발견되었습니다:\n\n${duplicateErrors.join('\n')}`,
          );
        }
      }
    }
    // ======== 중복번호 제어 체크 끝 ========

    // 신세계 상품 검증 및 이벤트 자동 선택
    if (order.type === IOrderType.SSG) {
      // 상품 가격으로 전체 가격 계산
      const totalPrice = order.orderProductMappings!.reduce((acc, cur) => {
        if (!cur.product) {
          throw new BadRequestException('상품 정보가 존재하지 않습니다.');
        }
        return acc + cur.product.price * cur.amount;
      }, 0);
      const firstProduct = order.orderProductMappings[0].product;
      if (!firstProduct) {
        throw new BadRequestException('상품 정보가 존재하지 않습니다.');
      }
      const couponExpiration = firstProduct.expireDay;

      // 이벤트 자동 선택 (주문 금액 전체를 커버 가능한 첫 번째 행사)
      const selectedEvent = await this.ssgEventService.selectEventForOrder(totalPrice, couponExpiration);

      if (!selectedEvent) {
        throw new BadRequestException('사용 가능한 SSG 이벤트가 없습니다. (잔액 부족)');
      }

      // 선택된 이벤트 ID를 주문에 저장
      order.ssgEventId = selectedEvent.id;

      // 이벤트 잔액 가차감 (isTemporary = true)
      await this.ssgEventService.deductEventBalance(selectedEvent.id, totalPrice, order.id, true);
    }

    for (const orderMapping of order.orderProductMappings!) {
      for (const orderDelivery of orderMapping.orderDeliveries) {
        orderDelivery.transactionId = CreateTransactionId(order.id, orderDelivery.id);
        await this.orderDeliveryRepository.save(orderDelivery);
      }
    }

    if (totalAmount > oneUser.balance) {
      oneUser.allSettleAmount += totalAmount;
      order.isSettleBalance = false;
    } else if (totalAmount <= oneUser.balance) {
      oneUser.balance = oneUser.balance - totalAmount;
      order.isSettleBalance = true;
    }

    order.status = IOrderStatus.DELIVERY_REQUEST;
    await this.orderRepository.save(order);
    await this.userRepository.save(oneUser);

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
    // 신세계 상품 검증 및 차감 확정
    if (order.type === IOrderType.SSG) {
      // 주문에 저장된 SSG 이벤트 ID 확인
      if (!order.ssgEventId) {
        throw new BadRequestException('SSG 이벤트가 선택되지 않았습니다.');
      }

      // 선택된 이벤트 조회
      ssgEventIssue = await this.ssgEventRepository.findOne({
        where: { id: order.ssgEventId },
      });

      if (!ssgEventIssue) {
        throw new BadRequestException('선택된 SSG 이벤트를 찾을 수 없습니다.');
      }

      // 가차감을 확정으로 변경 (isTemporary: true -> false)
      await this.ssgEventService.confirmEventBalance(order.id);
    }

    let message = 'success';

    for (const orderMapping of order.orderProductMappings!) {
      for (const orderDelivery of orderMapping.orderDeliveries) {
        // PIN 발급은 배치에서 실제 발송 시점에 수행
        // 여기서는 ssgEventId만 저장하고 상태를 WAIT으로 변경
        orderDelivery.status = IOrderDeliveryStatus.WAIT;
        orderDelivery.ssgEventId = ssgEventIssue ? ssgEventIssue.id : null;

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
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .where('order.id = :id', { id })
      // .andWhere('order.userId = :userId', { userId: user.id })
      // .andWhere('order.status = :status', { status: 'DELIVERY_REQUEST' })
      .getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않습니다.');
    }

    const oneUser = await this.userRepository.findOneOrFail({
      where: {
        id: order.userId,
      },
    });

    const now = new Date();
    // 첫 번째 상품의 발송 요청 시간 사용
    const firstMapping = order.orderProductMappings?.[0];
    const sendRequestAtTime = firstMapping?.sendRequestAt?.getTime() ?? 0;
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

    const totalPrice = order.orderProductMappings!.reduce((acc, cur) => {
      if (!cur.product) {
        throw new BadRequestException('상품 정보가 존재하지 않습니다.');
      }
      return acc + cur.product.price * cur.amount;
    }, 0);

    // SSG 주문인 경우 이벤트 잔액 복구
    if (order.type === IOrderType.SSG) {
      await this.ssgEventService.restoreEventBalance(order.id);

      // 사용자 잔액도 복원

      await this.userManagementService.addBalance(user.id, totalPrice);
    }

    if (order.isSettleBalance) {
      oneUser.balance = oneUser.balance + totalPrice;
      order.isSettleBalance = false;
    } else {
      oneUser.allSettleAmount -= totalPrice;
    }

    order.status = IOrderStatus.DELIVERY_CANCEL;
    await this.orderRepository.save(order);
    await this.orderDeliveryRepository.update(
      { orderProductMappingId: In(orderProductMappingIdList) },
      { status: IOrderDeliveryStatus.CANCEL },
    );
    await this.userRepository.save(oneUser);

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
    const startTime = Date.now();
    const { searchType, searchKeyword, type, status, startAt, endAt, section, password, downloadReason } = getBody;

    // 비밀번호 검증
    await this.activityLogService.verifyPassword(user.id, password);

    const now = new Date();
    const nowString = format(now, 'yyyyMMdd');
    let orderType = '';

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
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

    // 검색 조건 처리 (최소 1자 이상일 때만 검색)
    if (searchKeyword && searchKeyword.length >= 1) {
      switch (searchType) {
        case 'CUSTOMER':
          queryBuilder = queryBuilder.andWhere('user.businessName LIKE :keyword', { keyword: `%${searchKeyword}%` });
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
            '(user.businessName LIKE :keyword OR operationUser.personName LIKE :keyword OR order.eventName LIKE :keyword OR product.name LIKE :keyword)',
            { keyword: `%${searchKeyword}%` },
          );
          break;
      }
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

    const getSendRequestAt = ({
      status,
      actualSendAt,
      sendRequestAt,
      sendType,
    }: {
      status: string;
      actualSendAt: Date | null;
      sendRequestAt: Date | null;
      sendType: string | null;
    }) => {
      if (status === 'TEMP' || status === 'DELIVERY_CANCEL') return '-';

      if (actualSendAt) {
        return dayjs(actualSendAt).format('YYYY/MM/DD HH:mm:ss');
      }

      if (sendType === 'IMMEDIATE') {
        return '-';
      }

      if (sendRequestAt) {
        return dayjs(sendRequestAt).format('YYYY/MM/DD HH:mm:ss');
      }
      return '-';
    };

    let id = 1;
    for (const order of orderList) {
      let totalAmount = 0;
      let productName = '';
      let actualSendAt: Date | null = null;

      if (order.orderProductMappings && order.orderProductMappings.length > 0) {
        totalAmount = order.orderProductMappings.reduce((acc, cur) => {
          return acc + cur.amount;
        }, 0);
        const firstProduct = order.orderProductMappings[0].product;
        productName = firstProduct ? firstProduct.name : '(삭제된 상품)';
        const orderProductMappingsLength = order.orderProductMappings.length;
        if (orderProductMappingsLength - 1 > 0) {
          productName += `외 ${orderProductMappingsLength - 1}건`;
        }

        // 실제 발송 시간 추출 (첫 번째 유효한 값 사용)
        for (const mapping of order.orderProductMappings) {
          if (mapping.orderDeliveries) {
            for (const delivery of mapping.orderDeliveries) {
              if (delivery.actualSendAt) {
                actualSendAt = delivery.actualSendAt;
                break;
              }
            }
          }
          if (actualSendAt) break;
        }
      }

      // 첫 번째 상품의 발송 정보 사용
      const firstMapping = order.orderProductMappings?.[0];

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
        sendRequestAt: getSendRequestAt({
          status: order.status,
          actualSendAt: actualSendAt,
          sendRequestAt: firstMapping?.sendRequestAt ?? null,
          sendType: firstMapping?.sendType ?? null,
        }),
      });
      id++;
    }

    const fileName = `${orderType}_리스트_${nowString}.xlsx`;
    const filePath = join(process.cwd(), '.', 'public', fileName);

    await workbook.xlsx.writeFile(filePath);

    // 성공 로그 저장
    const responseTime = Date.now() - startTime;
    const recordCount = orderList.length;
    const { password: _, ...requestParams } = getBody;

    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/order/excel-download',
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

  async getMyOrderHistory(user: ILoginUserInfo): Promise<OrderGetMyOrderHistoryResDto> {
    // 1. 최근 7일 범위 설정 (7일 전 00:00:00부터)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    // 2. 상태·타입 배열 enum 값 참조
    const statuses = Object.values(IOrderStatus).filter((s) => s !== IOrderStatus.DELIVERY_CANCEL);
    const types = Object.values(IOrderType);

    // 3. 상태·타입 총합 CASE 절 생성
    const selectExpressions: string[] = statuses.flatMap((status) => {
      const byType = types.map(
        (type) =>
          `SUM(CASE WHEN o.status='${status}' AND o.type='${type}' THEN 1 ELSE 0 END)
       AS "${status.toLowerCase()}${type.charAt(0) + type.slice(1).toLowerCase()}Count"`,
      );
      const total = `SUM(CASE WHEN o.status='${status}' THEN 1 ELSE 0 END)
       AS "${status.toLowerCase()}TotalCount"`;

      return [...byType, total];
    });

    // 4. 쿼리 빌더로 raw 데이터 조회
    const queryBuilder = this.orderRepository
      .createQueryBuilder('o')
      .select(selectExpressions)
      .where('o.registerAt >= :from', { from: sevenDaysAgo.toISOString() })
      .andWhere('o.status IN (:...statuses)', { statuses })
      .andWhere('o.type IN (:...types)', { types });

    // 5. 권한에 따른 조회 제약
    switch (user.authority as IUserAuthority) {
      case IUserAuthority.SUPER_ADMIN:
        // 아무 제약 없이 전체 조회
        break;

      case IUserAuthority.OPERATION_ADMIN:
        // 본인 주문 OR 본인이 담당한 주문
        queryBuilder.andWhere('(o.userId = :uid OR o.operationUserId = :uid)', { uid: user.id });
        break;

      case IUserAuthority.CORPORATE_ADMIN:
      default:
        // 본인 주문만
        queryBuilder.andWhere('o.userId = :uid', { uid: user.id });
        break;
    }

    console.log('주문내역조회 API 시작 - 사용자ID:', user.id);

    // 6. raw 데이터를 숫자형으로 변환
    const raw = await queryBuilder.getRawOne<Record<string, string>>();
    const numeric: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw ?? {})) {
      numeric[k] = Number.parseInt(v, 10) || 0;
    }

    // 7. OrderGetMyOrderHistoryResDto 객체로 변환
    return Object.assign(new OrderGetMyOrderHistoryResDto(), numeric);
  }

  async testDelivery(user: ILoginUserInfo, getBody: OrderTestDeliveryReqDto) {
    const { orderId, orderProductMappingId, deliveryTarget } = getBody;

    // 최대 횟수
    const maxLimitCount = 2;
    const barCode = '999999';
    const order = await this.orderRepository.findOne({
      where: {
        id: orderId,
      },
    });

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    if (order.testDeliveryCount >= maxLimitCount) {
      throw new BadRequestException('테스트발송은 최대 2회입니다.');
    }

    // 알림톡일 경우 order.user도 필요하므로 항상 조인
    const orderProductMapping = await this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('order.user', 'user')
      .where('orderProductMapping.id = :id', { id: orderProductMappingId })
      .getOne();

    if (!orderProductMapping) {
      throw new BadRequestException('해당 주문-상품이 존재하지 않습니다. ');
    }

    const productExpireDay = orderProductMapping.product.expireDay || 0;
    const validityStartsNextDay = orderProductMapping.product.partnerCompany?.validityStartsNextDay ?? true;
    const expireDay = validityStartsNextDay ? productExpireDay : productExpireDay - 1;

    const expireDate = expireDay ? dayjs().tz('Asia/Seoul').add(expireDay, 'day').format('YYYY. MM. DD') : null;

    // 2. 쿠폰이미지 만들기
    const { path: imagePath } = await DeliveryCreateCouponImage(
      orderProductMapping.product.imagePath,
      orderProductMapping.product.name,
      barCode,
      orderProductMapping.product.brand!.nameKorean,
      expireDate,
      orderProductMapping.topImagePath,
      orderProductMapping.midImagePath,
      orderProductMapping.product.type,
    );

    const deliveryMethod = orderProductMapping.sendMethod!;

    const orderDelivery = new OrderDeliveryEntity();
    orderDelivery.deliveryMethod = deliveryMethod;
    orderDelivery.orderProductMappingId = orderProductMapping.id;
    orderDelivery.deliveryTarget = this.cryptoCipher.encryptDeliveryTarget(
      PhoneUtil.normalizeDeliveryTarget(deliveryTarget),
    );
    orderDelivery.barCode = barCode;
    orderDelivery.personalCode = barCode;
    orderDelivery.orderProductMapping = orderProductMapping;
    orderDelivery.imagePath = imagePath;
    orderDelivery.expireAt = new Date();

    // 3. 전송
    await this.deliveryBatchService.oneSend(orderDelivery, false);

    // 4. 테스트 알람 회수 증가 및 종료
    order.testDeliveryCount += 1;

    await this.orderRepository.save(order);
  }

  async getPreviousContent(
    user: ILoginUserInfo,
    getDto: OrderGetPreviousContentReqQueryDto,
  ): Promise<OrderGetPreviousContentResDto> {
    const { orderId, productId } = getDto;

    const response: OrderGetPreviousContentResDto = {
      sendTitle: null,
      sendContent: null,
    };

    const order = await this.orderRepository.findOne({
      where: {
        id: orderId,
      },
    });

    if (!order) {
      return response;
    }

    const queryBuilder = this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .where('orderProductMapping.id != :id', { id: orderId })
      .andWhere('order.userId = :userId', { userId: user.id })
      .andWhere('order.status IN (:...statusList)', {
        statusList: [IOrderStatus.DELIVERY_REQUEST, IOrderStatus.DELIVERY_CONFIRMED, IOrderStatus.DELIVERY_COMPLETE],
      })
      .andWhere('order.type = :type', { type: order.type })
      .orderBy('orderProductMapping.id', 'DESC');

    if (productId) {
      queryBuilder.andWhere('orderProductMapping.productId = :productId', { productId });
    }

    const orderProductMapping = await queryBuilder.getOne();

    if (orderProductMapping) {
      response.sendTitle = orderProductMapping.sendTitle ?? '';
      response.sendContent = orderProductMapping.sendContent ?? '';
      return response;
    }

    return response;
  }

  /**
   * 독려문자 설정 수정 (발송관리용, 상품별)
   * @param orderProductMappingId order_product_mapping의 id
   */
  async updateEncourageDay(user: ILoginUserInfo, orderProductMappingId: number, getBody: OrderUpdateEncourageDayReqBodyDto): Promise<void> {
    const { encourageDay } = getBody;

    const orderProductMapping = await this.orderProductMappingRepository.findOne({
      where: { id: orderProductMappingId },
      relations: ['order'],
    });

    if (!orderProductMapping) {
      throw new BadRequestException('존재하지 않는 상품입니다.');
    }

    // 발송관리에서만 수정 가능 (주문완료 상태 이상)
    if (orderProductMapping.order.status === IOrderStatus.TEMP) {
      throw new BadRequestException('임시저장 상태에서는 독려문자를 설정할 수 없습니다.');
    }

    // 독려문자 사용 설정 시 유효기간 검증
    if (encourageDay !== null) {
      // 해당 상품의 배송 정보 중 가장 빠른 만료일 조회
      const orderDelivery = await this.orderDeliveryRepository
        .createQueryBuilder('orderDelivery')
        .where('orderDelivery.orderProductMappingId = :orderProductMappingId', { orderProductMappingId })
        .andWhere('orderDelivery.expireAt IS NOT NULL')
        .orderBy('orderDelivery.expireAt', 'ASC')
        .getOne();

      if (orderDelivery?.expireAt) {
        const now = new Date();
        const expireAt = new Date(orderDelivery.expireAt);
        const diffTime = expireAt.getTime() - now.getTime();
        const remainingDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        // 유효기간이 이미 지난 경우
        if (remainingDays <= 0) {
          throw new BadRequestException('유효기간이 만료되어 독려문자를 설정할 수 없습니다.');
        }

        // 독려일이 남은 유효기간보다 큰 경우
        if (encourageDay >= remainingDays) {
          throw new BadRequestException(`남은 유효기간(${remainingDays}일)보다 작은 값을 입력해주세요.`);
        }
      }
    }

    orderProductMapping.encourageDay = encourageDay;
    await this.orderProductMappingRepository.save(orderProductMapping);
  }
}
