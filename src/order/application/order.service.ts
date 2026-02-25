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
  OrderGetDestructionCertificatePdfReqDto,
  OrderGetDetailReqParamDto,
  OrderGetListReqDto,
  OrderGetOrderCompleteReportPdfReqDto,
  OrderGetOrderCompleteReportReqDto,
  OrderGetPreviousContentReqQueryDto,
  OrderGetSettleReqDto,
  OrderReviewCompleteReqDto,
  OrderTestDeliveryReqDto,
  OrderUpdateOperationUserReqDto,
  OrderUpdateSettleReqDto,
  OrderUpdateTempReqDto,
  OrderUpdateEncourageDayReqBodyDto,
  OrderUpdateTailTextReqBodyDto,
  OrderUpdateUseEmailContentReqBodyDto,
  OrderTransactionStatementEmailReqDto,
  OrderDestructionCertificateEmailReqDto,
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
import { TestOrderDeliveryEntity } from '../../entity/test.order.delivery.entity';
import { ProductEntity } from '../../entity/product.entity';
import { OrderValidation } from '../domain/order.validation';
import { listToMap, listToMapValue } from '../../util/map.util';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { CreateTransactionId } from '../domain/create.transaction.id';
import { PartnerCompanyExternService } from '../../partner_company_extern/application/partner.company.extern.service';
import { DeliveryCreateCouponImage } from '../../delivery/infra/delivery.create.coupon.image';
import { UserEntity } from '../../entity/user.entity';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import { UserViewScopeEntity, ViewScopeType } from '../../entity/user.view.scope.entity';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserSettleCondition } from '../../user/interface/user.settle.condition';
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
import { IUserDiscountCategory } from '../../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../../user_discount/interface/user.discount.method';
import { ICompareCondition } from '../../user_discount/interface/compare.condition';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { IOrderType } from '../interface/order.type';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { SsgEventAmountHistoryEntity } from '../../entity/ssg.event.amount.history.entity';
import { IProductType } from '../../product/interface/product.type';
import { defaultOrderMidImagePath, defaultOrderTopImagePath } from '../../const';
import { OrderStatusExcelMapping } from '../domain/order.excel.mapping';
import { OrderFeeCalculator } from '../domain/order.fee.calculator';
import { OrderCustomerViewDto } from '../api/dto/order.customer.view.dto';
import { maskBarCode } from '../../util/mask.barcode.util';
import { MaskingUtil } from '../../common/utils/masking.util';
import { CreateCode } from '../../common/domain/create.code';
import { OrderDigitNumber, OrderPrefixCode } from '../domain/order.code';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { PhoneUtil } from '../../common/utils/phone.util';
import { DeliveryBatchService } from '../../delivery/application/delivery.batch.service';
import { IOrderSendMethod } from '../interface/order.send.method';
import { OrderEncryptKey } from '../../order_receive/interface/order.encrypt.key';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { MailSendSmtp } from '../../mail/infrastructure/mail-send.smtp';
import { OrderDeliveryCompleteReportEmailReqDto } from '../api/order.req.dto';
import { EmailSendHistoryEntity } from '../../entity/email.send.history.entity';
import { EmailType } from '../../mail/domain/email.type';

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
    @InjectRepository(TestOrderDeliveryEntity)
    private testOrderDeliveryRepository: Repository<TestOrderDeliveryEntity>,
    @InjectRepository(ProductEntity)
    private productRepository: Repository<ProductEntity>,
    @InjectRepository(UserDiscountEntity)
    private userDiscountRepository: Repository<UserDiscountEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(UserCompanyEntity)
    private userCompanyRepository: Repository<UserCompanyEntity>,
    @InjectRepository(SsgEventEntity)
    private ssgEventRepository: Repository<SsgEventEntity>,
    @InjectRepository(SsgEventAmountHistoryEntity)
    private ssgEventAmountHistoryRepository: Repository<SsgEventAmountHistoryEntity>,
    @InjectRepository(UserViewScopeEntity)
    private userViewScopeRepository: Repository<UserViewScopeEntity>,
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
    // @Inject('IFileStorage')
    // private fileStorage: IFileStorage,
    private deliveryBatchService: DeliveryBatchService,
    private activityLogService: ActivityLogService,
    private mailSendSmtp: MailSendSmtp,
    @InjectRepository(EmailSendHistoryEntity)
    private emailSendHistoryRepository: Repository<EmailSendHistoryEntity>,
  ) {}

  async getList(user: ILoginUserInfo, getQuery: OrderGetListReqDto): Promise<OrderGetListResDto> {
    const { section, type, status, startAt, endAt, searchType, searchKeyword, page, take } = getQuery;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.type = :type', { type });

    // 현재 사용자 정보 및 조회 범위 설정 조회
    const currentUser = await this.userRepository.findOne({
      where: { id: user.id },
      select: ['id', 'companyId', 'departmentId'],
    });

    const viewScope = await this.userViewScopeRepository.findOne({
      where: { userId: user.id },
    });

    // view_scope 기반 조회 조건 적용 함수
    const applyViewScopeFilter = () => {
      const scopeType = viewScope?.scopeType ?? ViewScopeType.SELF;

      // 본인 관련 주문 조회 조건 (본인 주문 + 배정된 주문 + 담당 고객으로 지정된 주문)
      const applyUserOrderFilter = () => {
        queryBuilder = queryBuilder.andWhere(
          '(order.userId = :userId OR order.operationUserId = :userId OR order.clientUserId = :userId)',
          { userId: user.id },
        );
      };

      switch (scopeType) {
        case ViewScopeType.ALL:
          // 전체 조회 - 조건 없음
          break;
        case ViewScopeType.COMPANY:
          // 같은 회사 전체 조회
          if (currentUser?.companyId) {
            queryBuilder = queryBuilder.andWhere('user.companyId = :companyId', {
              companyId: currentUser.companyId,
            });
          } else {
            applyUserOrderFilter();
          }
          break;
        case ViewScopeType.DEPARTMENT: {
          // 같은 부서 + 추가 부서들 조회
          const deptIds = viewScope?.getDeptIdList() ?? [];
          const targetDeptIds = currentUser?.departmentId ? [currentUser.departmentId, ...deptIds] : deptIds;

          if (targetDeptIds.length > 0) {
            queryBuilder = queryBuilder.andWhere('user.departmentId IN (:...deptIds)', {
              deptIds: targetDeptIds,
            });
          } else {
            applyUserOrderFilter();
          }
          break;
        }
        case ViewScopeType.SELF:
        default:
          applyUserOrderFilter();
          break;
      }
    };

    // 주문 관리 일 경우
    if (section === IOrderSection.ORDER) {
      applyViewScopeFilter();
    }

    // 발송관리 일 경우
    if (section === IOrderSection.SHIPPING) {
      // 발송관리에서는 임시저장 상태 제외
      queryBuilder = queryBuilder.andWhere('order.status != :tempStatus', { tempStatus: IOrderStatus.TEMP });
      applyViewScopeFilter();
    }

    if (status) {
      queryBuilder = queryBuilder.andWhere('order.status = :status', { status });
    }

    // 검색 조건 처리 (최소 1자 이상일 때만 검색)
    if (searchKeyword && searchKeyword.length >= 1) {
      switch (searchType) {
        case 'CUSTOMER':
          queryBuilder = queryBuilder.andWhere(
            '(userCompany.businessName LIKE :keyword OR clientCompany.businessName LIKE :keyword)',
            { keyword: `%${searchKeyword}%` },
          );
          break;
        case 'MANAGER':
          queryBuilder = queryBuilder.andWhere(
            '(user.personName LIKE :keyword OR clientUser.personName LIKE :keyword)',
            { keyword: `%${searchKeyword}%` },
          );
          break;
        case 'OPERATION_ADMIN':
          queryBuilder = queryBuilder.andWhere('operationUser.personName LIKE :keyword', {
            keyword: `%${searchKeyword}%`,
          });
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
            `(${[
              'userCompany.businessName LIKE :keyword',
              'clientCompany.businessName LIKE :keyword',
              'user.personName LIKE :keyword',
              'clientUser.personName LIKE :keyword',
              'operationUser.personName LIKE :keyword',
              'order.eventName LIKE :keyword',
              'product.name LIKE :keyword',
            ].join(' OR ')})`,
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

        // 실제 발송 시간: 성공한 배송 건 중 하나의 actualSendAt 사용
        for (const mapping of order.orderProductMappings) {
          for (const delivery of mapping.orderDeliveries ?? []) {
            if (
              delivery.actualSendAt &&
              (delivery.status === IOrderDeliveryStatus.COMPLETE ||
                delivery.status === IOrderDeliveryStatus.COMPLETE_SMS)
            ) {
              actualSendAt = format(delivery.actualSendAt, DateFormatStr);
              break;
            }
          }
          if (actualSendAt) break;
        }
      }

      // 발송 실패 건 포함 여부 확인
      const hasFailedDelivery = order.orderProductMappings?.some((mapping) =>
        mapping.orderDeliveries?.some(
          (delivery) =>
            delivery.status === IOrderDeliveryStatus.FAIL || delivery.status === IOrderDeliveryStatus.FAIL_SMS,
        ),
      ) ?? false;

      // 재발송 완료 건 포함 여부 확인
      const hasResentDelivery = order.orderProductMappings?.some((mapping) =>
        mapping.orderDeliveries?.some((delivery) => delivery.resendAt != null),
      ) ?? false;

      // 첫 번째 상품의 발송 정보 사용
      const firstMapping = order.orderProductMappings?.[0];
      // sendRequestAt: 예약 발송 요청 시간 (actualSendAt이 없을 때 폴백용)
      const sendRequestAt = firstMapping?.sendRequestAt ? format(firstMapping.sendRequestAt, DateFormatStr) : null;

      return {
        id: order.id,
        registerAt: format(order.registerAt, DateFormatStr),
        userBusinessName: order.clientUser?.company?.businessName ?? order.user!.company?.businessName ?? '',
        userPersonName: order.clientUser?.personName ?? order.user!.personName,
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
        hasFailedDelivery,
        hasResentDelivery,
      };
    });

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  async getDetail(getParam: OrderGetDetailReqParamDto): Promise<OrderGetDetailResDto> {
    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .leftJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .where('order.id = :id', { id: getParam.id })
      .addOrderBy('orderDeliveries.id', 'ASC');

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

        // 발송 완료된 건의 경우 첫 번째 배송의 actualSendAt 사용
        const firstDelivery = orderProductMapping.orderDeliveries?.[0];
        const baseDate = firstDelivery?.actualSendAt
          ? dayjs(firstDelivery.actualSendAt)
          : orderProductMapping.sendType === 'IMMEDIATE'
            ? dayjs()
            : dayjs(orderProductMapping.sendRequestAt);

        const expireDate = expireDay ? baseDate.tz('Asia/Seoul').add(expireDay, 'day').format('YYYY. MM. DD') : null;

        for (const orderDelivery of orderProductMapping.orderDeliveries) {
          // deliveryTarget 복호화 (originalDeliveryTarget 우선 사용)
          const targetToDecrypt = orderDelivery.originalDeliveryTarget || orderDelivery.deliveryTarget;
          let decryptedDeliveryTarget = targetToDecrypt;
          if (targetToDecrypt) {
            try {
              decryptedDeliveryTarget = this.cryptoCipher.decryptDeliveryTarget(targetToDecrypt);
            } catch (error) {
              // 복호화 실패 시 원본 데이터 사용
              decryptedDeliveryTarget = targetToDecrypt;
            }
          }

          orderDeliveryList.push({
            id: orderDelivery.id,
            deliveryTarget: decryptedDeliveryTarget,
            replaceCharacter1: orderDelivery.replaceCharacter1,
            replaceCharacter2: orderDelivery.replaceCharacter2,
            replaceCharacter3: orderDelivery.replaceCharacter3,
            status: orderDelivery.status,
            isResent: orderDelivery.resendAt !== null,
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
              partnerCompanyName: orderProductMapping.product.partnerCompany?.businessName ?? '',
            }
          : null;

        if (!product) {
          continue;
        }

        // 해당 상품의 발송 실패 건수 계산
        const failCount = orderProductMapping.orderDeliveries.filter(
          (delivery) =>
            delivery.status === IOrderDeliveryStatus.FAIL || delivery.status === IOrderDeliveryStatus.FAIL_SMS,
        ).length;

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
          failCount: failCount,
        });
      }
    }

    // 총 발송 실패 건수 계산
    const totalFailCount = productList.reduce((acc, product) => acc + product.failCount, 0);

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
      isPreSettle: user.settleCondition === IUserSettleCondition.PRE_PAYMENT,
      cancelReason: order.cancelReason,
      canceledAt: order.canceledAt ? format(order.canceledAt, DateFormatStr) : null,
      totalFailCount: totalFailCount,
      // 대행주문 관련 정보
      clientUserId: order.clientUserId ?? null,
      clientUserName: order.clientUser?.personName ?? null,
      clientCompanyName: order.clientUser?.company?.businessName ?? null,
      operationUserId: order.operationUserId ?? null,
      operationUserName: order.operationUser?.personName ?? null,
    };
  }

  // 이벤트 불러오기 전용 메서드 (수신자 정보 제외)
  async getEventDetail(getParam: OrderGetDetailReqParamDto): Promise<OrderGetDetailResDto> {
    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
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
          failCount: 0, // 이벤트 불러오기 시 발송 정보가 없으므로 0
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
      isPreSettle: order.user!.settleCondition === IUserSettleCondition.PRE_PAYMENT,
      cancelReason: order.cancelReason,
      canceledAt: order.canceledAt ? format(order.canceledAt, DateFormatStr) : null,
      totalFailCount: 0, // 이벤트 불러오기 시 발송 정보가 없으므로 0
      // 대행주문 관련 정보
      clientUserId: order.clientUserId ?? null,
      clientUserName: order.clientUser?.personName ?? null,
      clientCompanyName: order.clientUser?.company?.businessName ?? null,
      operationUserId: order.operationUserId ?? null,
      operationUserName: order.operationUser?.personName ?? null,
    };
  }

  async getDeliveryCompleteReport(
    getQuery: OrderGetDeliveryCompleteReportReqDto,
  ): Promise<OrderGetDeliveryCompleteReportResDto> {
    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
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
    // 대행주문인 경우 clientUser, 아니면 user 정보 사용
    const billingUser = order.clientUser ?? order.user;
    const userInfo: OrderCustomerViewDto = {
      id: billingUser?.id ?? null,
      userBusinessName: billingUser?.company?.businessName ?? null,
      userPersonPhoneNumber: billingUser?.personPhoneNumber ?? null,
      userBusinessEmail: billingUser?.email ?? null,
      userPersonName: billingUser?.personName ?? null,
    };
    const now = new Date();
    const today = format(now, 'yyMMdd');
    const fileName: string = `${billingUser?.company?.businessName ?? ''}_발송완료리포트_${today}`;

    if (order.orderProductMappings && order.orderProductMappings.length > 0) {
      for (const orderProductMapping of order.orderProductMappings) {
        const orderDeliveryList: OrderDeliveryCompleteReportViewDto[] = [];
        const productExpireDay = orderProductMapping.product.expireDay || 0;
        const validityStartsNextDay = orderProductMapping.product.partnerCompany?.validityStartsNextDay ?? true;
        const expireDay = validityStartsNextDay ? productExpireDay : productExpireDay - 1;

        // 발송 완료된 건의 경우 첫 번째 배송의 actualSendAt 사용
        const firstDelivery = orderProductMapping.orderDeliveries?.[0];
        const baseDate = firstDelivery?.actualSendAt ? dayjs(firstDelivery.actualSendAt) : dayjs();

        const expireDate = expireDay ? baseDate.tz('Asia/Seoul').add(expireDay, 'day').format('YYYY. MM. DD') : null;

        for (const orderDelivery of orderProductMapping.orderDeliveries) {
          // deliveryTarget 복호화 후 마스킹 처리 (originalDeliveryTarget 우선 사용)
          const targetToDecrypt = orderDelivery.originalDeliveryTarget || orderDelivery.deliveryTarget;
          let decryptedDeliveryTarget = targetToDecrypt;
          if (targetToDecrypt) {
            try {
              decryptedDeliveryTarget = this.cryptoCipher.decryptDeliveryTarget(targetToDecrypt);
            } catch (error) {
              // 복호화 실패 시 원본 데이터 사용
              decryptedDeliveryTarget = targetToDecrypt;
            }
          }

          // 파기된 경우('-')는 마스킹하지 않고 그대로 반환
          let finalDeliveryTarget = decryptedDeliveryTarget;
          if (decryptedDeliveryTarget !== '-') {
            if (orderProductMapping.sendMethod === 'EMAIL') {
              // 이메일인 경우 이메일 마스킹
              finalDeliveryTarget = MaskingUtil.maskEmail(decryptedDeliveryTarget);
            } else {
              // 전화번호인 경우 전화번호 마스킹
              finalDeliveryTarget = maskBarCode(decryptedDeliveryTarget);
            }
          }

          orderDeliveryList.push({
            id: orderDelivery.id,
            sendRequestAt: orderDelivery.sendRequestAt ? format(orderDelivery.sendRequestAt, DateFormatStr) : null,
            actualSendAt: orderDelivery.actualSendAt ? format(orderDelivery.actualSendAt, DateFormatStr) : null,
            productName: orderProductMapping.product.name ?? null,
            amount: orderProductMapping.product.price ?? null,
            barCode: orderDelivery.barCode ? maskBarCode(orderDelivery.barCode) : null,
            deliveryMethod: orderDelivery.deliveryMethod,
            deliveryTarget: finalDeliveryTarget,
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

    // 실제 발송 시간 추출 (모든 상품 중 가장 늦은 날짜 사용)
    let latestActualSendAt: Date | null = null;
    for (const mapping of order.orderProductMappings || []) {
      if (mapping.orderDeliveries) {
        for (const delivery of mapping.orderDeliveries) {
          if (delivery.actualSendAt) {
            const sendDate = new Date(delivery.actualSendAt);
            if (!latestActualSendAt || sendDate > latestActualSendAt) {
              latestActualSendAt = sendDate;
            }
          }
        }
      }
    }
    const actualSendAt = latestActualSendAt ? format(latestActualSendAt, DateFormatStr) : null;

    // 상품별 발송정보 목록 생성
    const sendInfoList: { productName: string; sendTitle: string | null; sendContent: string | null }[] = [];
    for (const mapping of order.orderProductMappings || []) {
      sendInfoList.push({
        productName: mapping.product?.name ?? '',
        sendTitle: mapping.sendTitle ?? null,
        sendContent: mapping.sendContent ?? null,
      });
    }

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
      actualSendAt: actualSendAt,
      // 발송 정보 추가 (첫 번째 상품의 정보 사용)
      sendMethod: firstMapping?.sendMethod ?? null,
      sendTitle: firstMapping?.sendTitle ?? null,
      sendContent: firstMapping?.sendContent ?? null,
      sendRequestAt: firstMapping?.sendRequestAt ? format(firstMapping.sendRequestAt, DateFormatStr) : null,
      fromPhoneNumber: firstMapping?.fromPhoneNumber ?? null,
      fromEmail: firstMapping?.fromEmail ?? null,
      encourageDay: firstMapping?.encourageDay ?? null,
      sendInfoList,
    };
  }

  async deliveryCompleteReportPdf(
    getBody: OrderGetDeliveryCompleteReportPdfReqDto,
    user: ILoginUserInfo,
    ipAddress: string,
  ): Promise<void> {
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
    order.deliveryReportLastSource = getBody.source || 'DOCUMENT';

    await this.orderRepository.save(order);

    // activity_log에 기록
    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/order/delivery-complete/report/pdf',
      actionType: 'DELIVERY_COMPLETE_REPORT',
      ipAddress,
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime: 0,
      requestParams: { orderId: getBody.id, source: getBody.source },
    });

    return;
  }

  async getOrderCompleteReport(
    getQuery: OrderGetOrderCompleteReportReqDto,
  ): Promise<OrderGetOrderCompleteReportResDto> {
    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
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
        const originalPrice = orderProductMapping.product.price ?? 0;
        const quantity = orderProductMapping.amount ?? 0;

        // 할인/할증 적용된 단가 계산 (소수점 발생 시 올림 처리)
        let adjustedPrice = originalPrice;
        if (orderProductMapping.fee !== null && orderProductMapping.fee > 0 && orderProductMapping.priceAdjustment) {
          if (orderProductMapping.priceAdjustment === IPriceAdjustment.DISCOUNT) {
            adjustedPrice = Math.ceil((originalPrice * (100 - orderProductMapping.fee)) / 100);
          } else if (orderProductMapping.priceAdjustment === IPriceAdjustment.ADDITIONAL) {
            adjustedPrice = Math.ceil((originalPrice * (100 + orderProductMapping.fee)) / 100);
          }
        }

        const total = adjustedPrice * quantity;
        price += total;

        // 상품별로 한 줄만 추가 (첫 번째 orderDelivery의 발송 시각 사용)
        const firstDelivery = orderProductMapping.orderDeliveries?.[0];
        orderDeliveryList.push({
          id: orderProductMapping.id, // orderProductMapping id 사용
          sendRequestAt: firstDelivery?.sendRequestAt ? format(firstDelivery.sendRequestAt, DateFormatStr) : null,
          productName: orderProductMapping.product.name ?? null,
          quantity, // 수량
          unitPrice: adjustedPrice, // 할인/할증 적용된 단가
          price: total, // 공급가액 (단가 * 수량)
        });
      }

      // vat = Math.floor(price * 0.1);
      totalAmount = price + vat;
    }

    // 첫 번째 상품의 발송 요청 시간 사용
    const firstMapping = order.orderProductMappings?.[0];
    const sendRequestAt =
      firstMapping && normalizeDate(firstMapping.sendRequestAt)
        ? format(firstMapping.sendRequestAt!, DateFormatStr)
        : null;

    // 대행주문인 경우 clientUser, 아니면 user 정보 사용
    const billingUser = order.clientUser ?? order.user;

    return {
      fileName,
      serialNumber,
      userSettleCondition: billingUser!.settleCondition,
      businessName: billingUser!.company?.businessName ?? '',
      businessNumber: billingUser!.company?.businessNumber ?? '',
      personName: billingUser!.personName,
      businessAddress: billingUser?.company?.businessAddress ?? null,
      businessType: billingUser?.company?.industryType ?? null,
      businessItem: billingUser?.company?.industryItem ?? null,
      eventName: order.eventName,
      sendRequestAt: sendRequestAt ?? null,
      price,
      vat,
      totalAmount,
      orderDeliveryList,
    };
  }

  async orderCompleteReportPdf(
    getBody: OrderGetOrderCompleteReportPdfReqDto,
    user: ILoginUserInfo,
    ipAddress: string,
  ): Promise<void> {
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
    order.transactionStatementLastSource = getBody.source || 'DOCUMENT';

    await this.orderRepository.save(order);

    // activity_log에 기록
    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/order/order-complete/report/pdf',
      actionType: 'TRANSACTION_STATEMENT',
      ipAddress,
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime: 0,
      requestParams: { orderId: getBody.id, source: getBody.source },
    });

    return;
  }

  async destructionCertificatePdf(
    getBody: OrderGetDestructionCertificatePdfReqDto,
    user: ILoginUserInfo,
    ipAddress: string,
  ): Promise<void> {
    const order = await this.orderRepository.findOne({
      where: { id: getBody.id },
    });

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    // activity_log에 기록
    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/order/destruction-certificate/pdf',
      actionType: 'DESTRUCTION_CERTIFICATE',
      ipAddress,
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime: 0,
      requestParams: { orderId: getBody.id },
    });

    return;
  }

  /**
   * 다중 주문 발송완료 리포트 조회 (통합)
   */
  async getDeliveryCompleteReportMultiple(ids: string, evidenceDate?: string): Promise<any> {
    const orderIds = ids.split(',').map((id) => parseInt(id.trim(), 10));
    // 증빙일자가 있으면 파싱
    const evidenceDateParsed = evidenceDate ? new Date(evidenceDate) : null;

    if (orderIds.length === 0) {
      throw new BadRequestException('주문 ID가 필요합니다.');
    }

    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id IN (:...ids)', { ids: orderIds });

    const orders = await queryBuilder.getMany();

    if (orders.length === 0) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    // 모든 주문이 발송 완료 상태인지 확인
    for (const order of orders) {
      if (order.status !== IOrderStatus.DELIVERY_COMPLETE) {
        throw new BadRequestException('발송 완료된 건에 대해서만 조회 가능합니다.');
      }
    }

    // 모든 주문이 같은 과금 대상 회사 소속인지 확인 (다중 주문 증빙 발행 시)
    if (orders.length > 1) {
      const getBillingCompanyId = (order: OrderEntity) => {
        const billingUser = order.clientUser ?? order.user;
        return billingUser?.companyId;
      };
      const firstCompanyId = getBillingCompanyId(orders[0]);
      const allSameCompany = orders.every((order) => getBillingCompanyId(order) === firstCompanyId);
      if (!allSameCompany) {
        throw new BadRequestException('서로 다른 회사의 주문은 합쳐서 증빙 발행할 수 없습니다.');
      }
    }

    // 첫 번째 주문 기준으로 기본 정보 설정
    const firstOrder = orders[0];
    // 대행주문인 경우 clientUser, 아니면 user 정보 사용
    const billingUser = firstOrder.clientUser ?? firstOrder.user;
    const userInfo: OrderCustomerViewDto = {
      id: billingUser?.id ?? null,
      userBusinessName: billingUser?.company?.businessName ?? null,
      userPersonPhoneNumber: billingUser?.personPhoneNumber ?? null,
      userBusinessEmail: billingUser?.email ?? null,
      userPersonName: billingUser?.personName ?? null,
    };

    const now = new Date();
    const today = format(now, 'yyMMdd');
    const fileName: string = `${billingUser?.company?.businessName ?? ''}_발송완료리포트_${today}`;

    // 이벤트명 통합 (여러 개면 "a 외 n건" 형식)
    const eventNames = [...new Set(orders.map((o) => o.eventName))];
    const eventName = eventNames.length > 1 ? `${eventNames[0]} 외 ${eventNames.length - 1}건` : eventNames[0];

    // 모든 주문의 상품 목록 통합
    const productList: OrderPdfDetailProductDto[] = [];
    let firstMapping: any = null;
    let actualSendAt: string | null = null;
    const allMappings: any[] = [];

    for (const order of orders) {
      if (order.orderProductMappings && order.orderProductMappings.length > 0) {
        for (const orderProductMapping of order.orderProductMappings) {
          if (!firstMapping) {
            firstMapping = orderProductMapping;
          }
          allMappings.push(orderProductMapping);

          const orderDeliveryList: OrderDeliveryCompleteReportViewDto[] = [];
          const productExpireDay = orderProductMapping.product.expireDay || 0;
          const validityStartsNextDay = orderProductMapping.product.partnerCompany?.validityStartsNextDay ?? true;
          const expireDay = validityStartsNextDay ? productExpireDay : productExpireDay - 1;

          // 발송 완료된 건의 경우 첫 번째 배송의 actualSendAt 사용
          const firstDelivery = orderProductMapping.orderDeliveries?.[0];
          const baseDate = firstDelivery?.actualSendAt ? dayjs(firstDelivery.actualSendAt) : dayjs();

          const expireDate = expireDay ? baseDate.tz('Asia/Seoul').add(expireDay, 'day').format('YYYY. MM. DD') : null;

          for (const orderDelivery of orderProductMapping.orderDeliveries) {
            // deliveryTarget 복호화 후 마스킹 처리 (originalDeliveryTarget 우선 사용)
            const targetToDecrypt = orderDelivery.originalDeliveryTarget || orderDelivery.deliveryTarget;
            let decryptedDeliveryTarget = targetToDecrypt;
            if (targetToDecrypt) {
              try {
                decryptedDeliveryTarget = this.cryptoCipher.decryptDeliveryTarget(targetToDecrypt);
              } catch (error) {
                decryptedDeliveryTarget = targetToDecrypt;
              }
            }

            let finalDeliveryTarget = decryptedDeliveryTarget;
            if (decryptedDeliveryTarget !== '-') {
              if (orderProductMapping.sendMethod === 'EMAIL') {
                finalDeliveryTarget = MaskingUtil.maskEmail(decryptedDeliveryTarget);
              } else {
                finalDeliveryTarget = maskBarCode(decryptedDeliveryTarget);
              }
            }

            // 실제 발송 시간 추출 (증빙일자가 있으면 증빙일자 사용)
            if (!actualSendAt) {
              if (evidenceDateParsed) {
                actualSendAt = format(evidenceDateParsed, DateFormatStr);
              } else if (orderDelivery.actualSendAt) {
                actualSendAt = format(orderDelivery.actualSendAt, DateFormatStr);
              }
            }

            // 발송날짜: 증빙일자가 있으면 증빙일자 사용, 없으면 실발송일 사용
            const deliverySendRequestAt = evidenceDateParsed
              ? format(evidenceDateParsed, DateFormatStr)
              : orderDelivery.actualSendAt
                ? format(orderDelivery.actualSendAt, DateFormatStr)
                : null;

            orderDeliveryList.push({
              id: orderDelivery.id,
              sendRequestAt: deliverySendRequestAt,
              actualSendAt: orderDelivery.actualSendAt ? format(orderDelivery.actualSendAt, DateFormatStr) : null,
              productName: orderProductMapping.product.name ?? null,
              amount: orderProductMapping.product.price ?? null,
              barCode: orderDelivery.barCode ? maskBarCode(orderDelivery.barCode) : null,
              deliveryMethod: orderDelivery.deliveryMethod,
              deliveryTarget: finalDeliveryTarget,
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
    }

    let couponExpiration: number | null = null;
    if (firstOrder.type === IOrderType.SSG && productList.length > 0) {
      couponExpiration = productList[0].product?.expireDay ?? null;
    }

    return {
      id: firstOrder.id,
      orderIds: orderIds,
      fileName,
      userInfo,
      registerAt: format(firstOrder.registerAt, DateFormatStr),
      eventName: eventName,
      type: firstOrder.type,
      status: firstOrder.status,
      couponExpiration: couponExpiration,
      requestToDestroyPersonalInfoDay: firstMapping?.requestToDestroyPersonalInfoDay ?? 0,
      productList: productList,
      actualSendAt: actualSendAt,
      sendMethod: firstMapping?.sendMethod ?? null,
      // 발송 제목 통합 (여러 개면 "제목 외" 형식)
      sendTitle: allMappings.length > 1 ? `${firstMapping?.sendTitle ?? ''} 외` : (firstMapping?.sendTitle ?? null),
      // 발송 내용 통합 (여러 개면 "내용\n\n외" 형식)
      sendContent:
        allMappings.length > 1 ? `${firstMapping?.sendContent ?? ''}\n\n외` : (firstMapping?.sendContent ?? null),
      sendRequestAt: firstMapping?.sendRequestAt ? format(firstMapping.sendRequestAt, DateFormatStr) : null,
      fromPhoneNumber: firstMapping?.fromPhoneNumber ?? null,
      fromEmail: firstMapping?.fromEmail ?? null,
      encourageDay: firstMapping?.encourageDay ?? null,
    };
  }

  /**
   * 다중 주문 거래명세서 조회 (통합)
   */
  async getOrderCompleteReportMultiple(ids: string, evidenceDate?: string): Promise<any> {
    const orderIds = ids.split(',').map((id) => parseInt(id.trim(), 10));
    // 증빙일자가 있으면 파싱
    const evidenceDateParsed = evidenceDate ? new Date(evidenceDate) : null;

    if (orderIds.length === 0) {
      throw new BadRequestException('주문 ID가 필요합니다.');
    }

    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id IN (:...ids)', { ids: orderIds });

    const orders = await queryBuilder.getMany();

    if (orders.length === 0) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    for (const order of orders) {
      if (order.status !== IOrderStatus.DELIVERY_COMPLETE) {
        throw new BadRequestException('발송 완료된 건에 대해서만 조회 가능합니다.');
      }
    }

    // 모든 주문이 같은 과금 대상 회사 소속인지 확인 (다중 주문 증빙 발행 시)
    if (orders.length > 1) {
      const getBillingCompanyId = (order: OrderEntity) => {
        const billingUser = order.clientUser ?? order.user;
        return billingUser?.companyId;
      };
      const firstCompanyId = getBillingCompanyId(orders[0]);
      const allSameCompany = orders.every((order) => getBillingCompanyId(order) === firstCompanyId);
      if (!allSameCompany) {
        throw new BadRequestException('서로 다른 회사의 주문은 합쳐서 증빙 발행할 수 없습니다.');
      }
    }

    const firstOrder = orders[0];
    // 일련번호: 증빙일자가 있으면 증빙일자 사용, 없으면 주문 생성일 사용
    const serialDateStr = evidenceDateParsed
      ? format(evidenceDateParsed, DateDateFormatStr)
      : format(firstOrder.createdAt, DateDateFormatStr);
    const serialNumber: string = `${serialDateStr}-${orderIds.join('_')}`;
    const fileName: string = `${serialNumber}_거래명세서`;

    // 이벤트명 통합
    const eventNames = [...new Set(orders.map((o) => o.eventName))];
    const eventName = eventNames.length > 1 ? `${eventNames[0]} 외 ${eventNames.length - 1}건` : eventNames[0];

    const orderDeliveryList: OrderCompleteReportDeliveryViewDto[] = [];
    let price = 0;
    let vat = 0;
    let totalAmount = 0;
    // 거래일자: 증빙일자가 있으면 증빙일자 사용
    let sendRequestAt: string | null = evidenceDateParsed ? format(evidenceDateParsed, DateFormatStr) : null;

    for (const order of orders) {
      if (order.orderProductMappings && order.orderProductMappings.length > 0) {
        for (const orderProductMapping of order.orderProductMappings) {
          const originalPrice = orderProductMapping.product.price ?? 0;
          const quantity = orderProductMapping.amount ?? 0;

          let adjustedPrice = originalPrice;
          if (orderProductMapping.fee !== null && orderProductMapping.fee > 0 && orderProductMapping.priceAdjustment) {
            if (orderProductMapping.priceAdjustment === IPriceAdjustment.DISCOUNT) {
              adjustedPrice = Math.ceil((originalPrice * (100 - orderProductMapping.fee)) / 100);
            } else if (orderProductMapping.priceAdjustment === IPriceAdjustment.ADDITIONAL) {
              adjustedPrice = Math.ceil((originalPrice * (100 + orderProductMapping.fee)) / 100);
            }
          }

          const total = adjustedPrice * quantity;
          price += total;

          const firstDelivery = orderProductMapping.orderDeliveries?.[0];
          // 증빙일자가 없고 sendRequestAt도 없으면 첫 배송의 발송요청일 사용
          if (!sendRequestAt && firstDelivery?.sendRequestAt) {
            sendRequestAt = format(firstDelivery.sendRequestAt, DateFormatStr);
          }

          // 품목별 일자: 증빙일자가 있으면 증빙일자 사용
          const itemSendRequestAt = evidenceDateParsed
            ? format(evidenceDateParsed, DateFormatStr)
            : firstDelivery?.sendRequestAt
              ? format(firstDelivery.sendRequestAt, DateFormatStr)
              : null;

          orderDeliveryList.push({
            id: orderProductMapping.id,
            sendRequestAt: itemSendRequestAt,
            productName: orderProductMapping.product.name ?? null,
            quantity,
            unitPrice: adjustedPrice,
            price: total,
          });
        }
      }
    }

    totalAmount = price + vat;

    // 대행주문인 경우 clientUser, 아니면 user 정보 사용
    const billingUser = firstOrder.clientUser ?? firstOrder.user;

    return {
      orderIds: orderIds,
      fileName,
      serialNumber,
      userSettleCondition: billingUser!.settleCondition,
      businessName: billingUser!.company?.businessName ?? '',
      businessNumber: billingUser!.company?.businessNumber ?? '',
      personName: billingUser!.personName,
      businessAddress: billingUser?.company?.businessAddress ?? null,
      businessType: billingUser?.company?.industryType ?? null,
      businessItem: billingUser?.company?.industryItem ?? null,
      eventName: eventName,
      sendRequestAt: sendRequestAt ?? null,
      price,
      vat,
      totalAmount,
      orderDeliveryList,
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

    // 1. 유저의 주문 상품 조회 (classification 포함)
    const [orderProductList, totalCount] = await this.orderProductMappingRepository.findAndCount({
      where: {
        orderId: id,
      },
      skip,
      take,
      relations: ['product', 'product.brand', 'product.classification', 'orderDeliveries'],
    });

    // 2. 유저 및 협력사의 할인 옵션 전체 조회 (대행주문인 경우 clientUser의 할인옵션 사용)
    const billingUserId = order.clientUserId ?? order.userId;
    const partnerCompanyIds = [...new Set(orderProductList.map((op) => op.product.partnerCompanyId))];
    const userDiscounts = await this.userDiscountRepository.find({
      where: [{ userId: billingUserId }, { partnerCompanyId: In(partnerCompanyIds) }],
    });

    this.logger.debug(`[getOrderSettle] orderId=${id}, billingUserId=${billingUserId} (clientUserId=${order.clientUserId}, userId=${order.userId})`);
    this.logger.debug(`[getOrderSettle] partnerCompanyIds=${JSON.stringify(partnerCompanyIds)}`);
    this.logger.debug(`[getOrderSettle] userDiscounts count=${userDiscounts.length}`);
    userDiscounts.forEach((d) => {
      this.logger.debug(
        `[getOrderSettle] discount: id=${d.id}, category=${d.category}, method=${d.method}, group=${d.group}, primaryCategory=${d.primaryCategory}, range=${d.range}, compareCondition=${d.compareCondition}, priceAdjustment=${d.priceAdjustment}, pricePercent=${d.pricePercent}, userId=${d.userId}, partnerCompanyId=${d.partnerCompanyId}`,
      );
    });

    const resultList: OrderSettleViewDto[] = orderProductList.map((orderProduct) => {
      let priceAdjustment = orderProduct.priceAdjustment;
      let fee = orderProduct.fee;

      let discountPrice = orderProduct.product.price;
      const totalPrice = orderProduct.product.price * orderProduct.amount;
      let discountTotalPrice = orderProduct.product.price * orderProduct.amount;

      // 3. 할인 정보가 null 일 경우 상품에 맞는 할인 옵션 찾기
      if (!priceAdjustment || fee === null) {
        this.logger.debug(
          `[getOrderSettle] product: id=${orderProduct.product.id}, name=${orderProduct.product.name}, category='${orderProduct.product.category}', price=${orderProduct.product.price}, brand=${orderProduct.product.brand?.nameKorean ?? 'null'}`,
        );
        this.logger.debug(
          `[getOrderSettle] stored values: fee=${orderProduct.fee}, priceAdjustment=${orderProduct.priceAdjustment}`,
        );

        const matchingDiscount = this.findMatchingDiscount(
          {
            price: orderProduct.product.price,
            category: orderProduct.product.category,
            brand: orderProduct.product.brand,
          },
          userDiscounts,
        );

        this.logger.debug(
          `[getOrderSettle] matchingDiscount: ${matchingDiscount ? `id=${matchingDiscount.id}, category=${matchingDiscount.category}, method=${matchingDiscount.method}, group='${matchingDiscount.group}', range=${matchingDiscount.range}, compareCondition=${matchingDiscount.compareCondition}, priceAdjustment=${matchingDiscount.priceAdjustment}, pricePercent=${matchingDiscount.pricePercent}` : 'null (no match found)'}`,
        );

        // 4. 할인 정보가 존재하면 null 값만 채우기
        if (matchingDiscount) {
          priceAdjustment = priceAdjustment ?? matchingDiscount.priceAdjustment;
          fee = fee ?? matchingDiscount.pricePercent;
        }
        fee = fee ?? 0;
      }

      // fee 유효성 검사 (0은 허용)
      if (fee === null || fee < 0 || fee > 100) {
        fee = 0;
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

      // 해당 상품의 첫 번째 orderDelivery에서 refundRatio 가져오기
      const firstDelivery = orderProduct.orderDeliveries?.[0];
      const refund = firstDelivery?.refundRatio ?? null;

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
        refund,
      };
    });

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
        settleFee -= (oneOrderProduct.product.price * oneOrderProduct.amount * (settle.fee ?? 0)) / 100;
      }

      if (settle.priceAdjustment === 'ADDITIONAL') {
        settleFee += (oneOrderProduct.product.price * oneOrderProduct.amount * (settle.fee ?? 0)) / 100;
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

    // 환불률 업데이트: 각 orderProductMapping에 해당하는 orderDelivery들의 refundRatio 업데이트
    for (const settle of list) {
      if (settle.refund !== undefined) {
        await this.orderDeliveryRepository.update({ orderProductMappingId: settle.id }, { refundRatio: settle.refund });
      }
    }

    const order = existingOrderProducts[0].order;

    if (order.isNewBillingFlow) {
      // === 새 흐름 ===
      if (order.status === IOrderStatus.DELIVERY_CONFIRMED || order.status === IOrderStatus.DELIVERY_COMPLETE) {
        // 발송확정 후 정산 입력: difference 기반 조정 (updateOrderSettle 패턴)
        const difference = order.settleAmount - (sendAmount + settleFee);
        if (difference !== 0) {
          const oneUser = await this.userRepository.findOneOrFail({
            where: { id: oneUserId },
          });
          if (isSettleBalance) {
            oneUser.balance += difference;
          } else {
            oneUser.allSettleAmount -= difference;
          }
          await this.userRepository.save(oneUser);
        }
      }
      // DELIVERY_REQUEST, REVIEW_COMPLETE: 정산 정보만 저장 (balance 건드리지 않음)
    } else {
      // === 기존 흐름 ===
      const oneUser = await this.userRepository.findOneOrFail({
        where: { id: oneUserId },
      });

      if (isSettleBalance) {
        oneUser.balance = oneUser.balance + sendAmount - (settleAmount + settleFee);
      } else {
        oneUser.allSettleAmount = oneUser.allSettleAmount - sendAmount + (settleAmount + settleFee);
      }

      await this.userRepository.save(oneUser);
    }
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
    const isSettleBalance = existingOrderProducts[0].order.isSettleBalance;
    let settleFee = 0;

    const orderProductList = list.map((settle) => {
      const oneOrderProduct = existingOrderProductMap.get(settle.id);
      if (!oneOrderProduct) {
        throw new InternalServerErrorException('not exist order product');
      }

      if (settle.priceAdjustment === 'DISCOUNT') {
        settleFee -= (oneOrderProduct.product.price * oneOrderProduct.amount * (settle.fee ?? 0)) / 100;
      }

      if (settle.priceAdjustment === 'ADDITIONAL') {
        settleFee += (oneOrderProduct.product.price * oneOrderProduct.amount * (settle.fee ?? 0)) / 100;
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

    const newSettleAmount = settleAmount + settleFee;
    await this.orderRepository.update({ id: orderId }, { settleAmount: newSettleAmount });

    // 환불률 업데이트: 각 orderProductMapping에 해당하는 orderDelivery들의 refundRatio 업데이트
    for (const settle of list) {
      if (settle.refund !== undefined) {
        await this.orderDeliveryRepository.update({ orderProductMappingId: settle.id }, { refundRatio: settle.refund });
      }
    }

    // 발송확정 이후(DELIVERY_CONFIRMED, DELIVERY_COMPLETE)에 정산정보를 수정한 경우
    // 이전 정산금액과 새 정산금액의 차이를 balance/allSettleAmount에 반영
    const orderStatus = existingOrderProducts[0].order.status;
    if (orderStatus === IOrderStatus.DELIVERY_CONFIRMED || orderStatus === IOrderStatus.DELIVERY_COMPLETE) {
      const difference = beforeSettleAmount - newSettleAmount;

      if (difference !== 0) {
        const oneUser = await this.userRepository.findOneOrFail({
          where: { id: oneUserId },
        });

        if (isSettleBalance) {
          // 선충전에서 차감된 주문 → balance 조정
          oneUser.balance += difference;
          this.logger.debug(
            `정산정보 수정 (발송확정 후): orderId=${orderId}, 이전=${beforeSettleAmount}, 새=${newSettleAmount}, 차이=${difference}, balance 조정`,
          );
        } else {
          // 한도에서 차감된 주문 → allSettleAmount 조정
          oneUser.allSettleAmount -= difference;
          this.logger.debug(
            `정산정보 수정 (발송확정 후): orderId=${orderId}, 이전=${beforeSettleAmount}, 새=${newSettleAmount}, 차이=${difference}, allSettleAmount 조정`,
          );
        }

        await this.userRepository.save(oneUser);
      }
    }
    // 발송요청 상태(DELIVERY_REQUEST)인 경우 balance 조정은 deliveryConfirmed에서 수행됨
  }

  @Transactional()
  async createTemp(user: ILoginUserInfo, getBody: OrderCreateTempReqDto): Promise<OrderCreateTempResDto> {
    const { type, eventName, topImagePath, midImagePath, orderProductList } = getBody;

    // 사용자의 허용 발신수단 검증
    const userEntity = await this.userRepository.findOne({ where: { id: user.id } });
    if (!userEntity) {
      throw new BadRequestException('사용자 정보를 찾을 수 없습니다.');
    }
    const allowedMethods = userEntity.allowedSendMethods
      ? userEntity.allowedSendMethods.split(',')
      : ['ALIM_TALK', 'SMS', 'EMAIL'];

    for (const product of orderProductList) {
      if (product.sendMethod && !allowedMethods.includes(product.sendMethod)) {
        throw new BadRequestException(`허용되지 않은 발신수단입니다: ${product.sendMethod}`);
      }
    }

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

    // 대행주문인 경우 clientUserId 설정 및 operationUserId 자동 배정
    const clientUserId = getBody.clientUserId ?? null;
    const operationUserId = clientUserId ? user.id : null;

    const orderInsertResult = await this.orderRepository.insert({
      userId: user.id,
      status: IOrderStatus.TEMP,
      code: newCode,
      type,
      eventName,
      sendAmount: sendAmount,
      settleAmount: sendAmount,
      registerAt: new Date(),
      clientUserId,
      operationUserId,
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
        const encryptedTarget = this.cryptoCipher.encryptDeliveryTarget(
          PhoneUtil.normalizeDeliveryTarget(orderDelivery.deliveryTarget),
        );
        oneOrderDelivery.deliveryTarget = encryptedTarget;
        oneOrderDelivery.originalDeliveryTarget = encryptedTarget;
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

    if (order.status !== IOrderStatus.TEMP && order.status !== IOrderStatus.DELIVERY_CANCEL) {
      throw new BadRequestException('임시저장 또는 발송취소 상태가 아닐경우 수정할 수 없습니다.');
    }

    // 취소된 주문을 수정하는 경우 상태를 임시저장으로 변경하고 취소 정보 초기화
    const wasCanceled = order.status === IOrderStatus.DELIVERY_CANCEL;
    if (wasCanceled) {
      order.status = IOrderStatus.TEMP;
      order.cancelReason = null;
      order.canceledAt = null;
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

    // 대행주문 관련 정보 업데이트
    const clientUserId = getBody.clientUserId ?? null;
    order.clientUserId = clientUserId;
    if (clientUserId) {
      // 대행주문인 경우 현재 관리자를 운영 담당자로 자동 배정 (createTemp와 동일 로직)
      order.operationUserId = user.id;
    }

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
        const encryptedTarget = this.cryptoCipher.encryptDeliveryTarget(
          PhoneUtil.normalizeDeliveryTarget(orderDelivery.deliveryTarget),
        );
        oneOrderDelivery.deliveryTarget = encryptedTarget;
        oneOrderDelivery.originalDeliveryTarget = encryptedTarget;
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

    this.logger.log(`[deliveryRequest] 요청 - orderId: ${id}, userId: ${user.id}`);

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id = :id', { id })
      .andWhere('order.userId = :userId', { userId: user.id })
      .andWhere('order.status = :status', { status: IOrderStatus.TEMP })
      .getOne();

    this.logger.log(`[deliveryRequest] 조회 결과 - order: ${order ? order.id : 'null'}`);

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않거나, 임시저장 상태가 아닙니다.');
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

    // 과금 대상 userId 결정 (대행주문인 경우 clientUserId, 아니면 userId)
    const billingUserId = order.clientUserId ?? order.userId;
    this.logger.debug(
      `Billing User ID: ${billingUserId} (clientUserId: ${order.clientUserId}, userId: ${order.userId})`,
    );

    const oneUser = await this.userRepository.findOne({
      where: { id: billingUserId },
      relations: ['company'],
    });
    if (!oneUser) {
      throw new InternalServerErrorException('과금 대상 유저가 존재하지 않습니다.');
    }

    // 과금 모드 결정 (두 블록에서 공통 사용)
    const isCompanyBalanceMode = oneUser.company?.balanceManagementType === 'COMPANY';
    const effectiveBalance = isCompanyBalanceMode && oneUser.company
      ? oneUser.company.balance
      : oneUser.balance;

    if (!order.isNewBillingFlow) {
      // === 기존 흐름: 발송요청 시 잔액/한도 체크 ===
      let remainServiceAmount: number;
      if (oneUser.companyId && oneUser.company) {
        const companyUsers = await this.userRepository.find({
          where: { companyId: oneUser.companyId },
          select: ['id', 'allSettleAmount'],
        });
        const totalAllSettleAmount = companyUsers.reduce((sum, u) => sum + u.allSettleAmount, 0);
        remainServiceAmount = oneUser.company.maximumLimit + effectiveBalance - totalAllSettleAmount;
      } else {
        remainServiceAmount = effectiveBalance - oneUser.allSettleAmount;
      }

      if (totalAmount > remainServiceAmount) {
        throw new BadRequestException('최대 서비스 한도를 넘어 요청할 수 없습니다.');
      }
    }
    // 새 흐름(isNewBillingFlow=true): 발송요청 시 잔액/한도 체크 없음 (발송확정 시 차감)

    // 신세계 상품 검증 및 이벤트 자동 선택 (배송건별 행사 분할 할당)
    let ssgAllocations: { deliveryId: number; eventId: number; price: number }[] | null = null;

    if (order.type === IOrderType.SSG) {
      const firstProduct = order.orderProductMappings[0].product;
      if (!firstProduct) {
        throw new BadRequestException('상품 정보가 존재하지 않습니다.');
      }
      const couponExpiration = firstProduct.expireDay;

      // 모든 배송건 정보 수집 (각 배송건 = 상품권 1장)
      const deliveries: { deliveryId: number; price: number }[] = [];
      for (const orderMapping of order.orderProductMappings!) {
        if (!orderMapping.product) {
          throw new BadRequestException('상품 정보가 존재하지 않습니다.');
        }
        const price = orderMapping.product.price;
        for (const orderDelivery of orderMapping.orderDeliveries) {
          deliveries.push({
            deliveryId: orderDelivery.id,
            price,
          });
        }
      }

      // 배송건별 행사 할당 (All or Nothing)
      ssgAllocations = await this.ssgEventService.allocateEventsForDeliveries(deliveries, couponExpiration);

      if (!ssgAllocations) {
        throw new BadRequestException('사용 가능한 SSG 이벤트가 없습니다. (잔액 부족)');
      }

      // 첫 번째 할당된 행사 ID를 주문에 저장 (대표 행사)
      order.ssgEventId = ssgAllocations.length > 0 ? ssgAllocations[0].eventId : null;

      // 여러 행사에서 분할 차감 (isTemporary = true)
      await this.ssgEventService.deductEventBalanceMultiple(ssgAllocations, order.id, true);
    }

    // 배송건 저장 및 SSG 행사 할당
    const allocationMap = new Map<number, number>();
    if (ssgAllocations) {
      for (const alloc of ssgAllocations) {
        allocationMap.set(alloc.deliveryId, alloc.eventId);
      }
    }

    for (const orderMapping of order.orderProductMappings!) {
      for (const orderDelivery of orderMapping.orderDeliveries) {
        orderDelivery.transactionId = CreateTransactionId(order.id, orderDelivery.id);

        // SSG 주문인 경우 배송건에 할당된 행사 ID 저장
        if (order.type === IOrderType.SSG && allocationMap.has(orderDelivery.id)) {
          orderDelivery.ssgEventId = allocationMap.get(orderDelivery.id) || null;
        }

        await this.orderDeliveryRepository.save(orderDelivery);
      }
    }

    if (!order.isNewBillingFlow) {
      // === 기존 흐름: 발송요청 시 잔액 차감 ===
      if (totalAmount > effectiveBalance) {
        oneUser.allSettleAmount += totalAmount;
        order.isSettleBalance = false;
      } else {
        if (isCompanyBalanceMode && oneUser.company) {
          oneUser.company.balance -= totalAmount;
        } else {
          oneUser.balance -= totalAmount;
        }
        order.isSettleBalance = true;
      }

      await this.userRepository.save(oneUser);
      if (isCompanyBalanceMode && oneUser.company) {
        await this.userCompanyRepository.save(oneUser.company);
      }
    }
    // 새 흐름: 잔액 차감 없음 (발송확정 시 처리)

    order.status = IOrderStatus.DELIVERY_REQUEST;
    await this.orderRepository.save(order);

    return;
  }

  @Transactional()
  async reviewComplete(user: ILoginUserInfo, getBody: OrderReviewCompleteReqDto): Promise<void> {
    const { id } = getBody;

    const order = await this.orderRepository
      .createQueryBuilder('order')
      .where('order.id = :id', { id })
      .andWhere('order.status = :status', { status: IOrderStatus.DELIVERY_REQUEST })
      .getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않거나, 주문완료 상태가 아닙니다.');
    }

    order.status = IOrderStatus.REVIEW_COMPLETE;
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
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.classification', 'classification')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id = :id', { id })
      // .andWhere('order.userId = :userId', { userId: user.id })
      .andWhere('order.status = :status', { status: IOrderStatus.REVIEW_COMPLETE })
      .getOne();

    if (!order) {
      throw new BadRequestException('해당 주문건은 존재하지 않거나, 검토완료 상태가 아닙니다.');
    }

    OrderValidation(order);

    // 신세계 상품 검증 및 차감 확정
    if (order.type === IOrderType.SSG) {
      // 배송건에 SSG 이벤트가 할당되어 있는지 확인
      const hasSsgEvent = order.orderProductMappings!.some((mapping) =>
        mapping.orderDeliveries.some((delivery) => delivery.ssgEventId != null),
      );

      if (!hasSsgEvent) {
        throw new BadRequestException('SSG 이벤트가 선택되지 않았습니다.');
      }

      // 가차감을 확정으로 변경 (isTemporary: true -> false)
      await this.ssgEventService.confirmEventBalance(order.id);
    }

    let message = 'success';

    // 과금 대상 userId 결정 (대행주문인 경우 clientUserId, 아니면 userId)
    const billingUserId = order.clientUserId ?? order.userId;

    // 사용자 정보 조회 (중복번호 체크 및 잔액 조정에 필요)
    const oneUser = await this.userRepository.findOneOrFail({
      where: { id: billingUserId },
      relations: ['company'],
    });

    // balanceManagementType에 따른 balance 관리 모드 결정
    const isCompanyBalanceMode = oneUser.company?.balanceManagementType === 'COMPANY';

    // ======== 할인/할증 차액 정산 시작 ========
    // 발송요청 시 정가(sendAmount)로 차감되었으므로, 발송확정 시 최종 정산금액과의 차액을 조정
    const partnerCompanyIds = order
      .orderProductMappings!.map((m) => m.product.partnerCompanyId)
      .filter((id, index, arr) => arr.indexOf(id) === index);

    const userDiscounts = await this.userDiscountRepository.find({
      where: [{ userId: billingUserId }, { partnerCompanyId: In(partnerCompanyIds) }],
    });

    let totalSettleFee = 0;
    const mappingsToUpdate: OrderProductMappingEntity[] = [];

    // 각 매핑별 할인/할증 상태 저장 (중복번호 체크에 사용)
    const mappingPriceAdjustments = new Map<number, IPriceAdjustment | null>();

    for (const mapping of order.orderProductMappings!) {
      let fee = mapping.fee;
      let priceAdjustment = mapping.priceAdjustment;

      // fee 또는 priceAdjustment가 설정되지 않은 경우 할인 옵션에서 찾기
      if (fee === null || priceAdjustment === null) {
        const matchingDiscount = this.findMatchingDiscount(
          {
            price: mapping.product.price,
            category: mapping.product.category,
            brand: mapping.product.brand,
          },
          userDiscounts,
        );

        if (matchingDiscount) {
          fee = fee ?? matchingDiscount.pricePercent;
          priceAdjustment = priceAdjustment ?? matchingDiscount.priceAdjustment;

          // 매핑에 할인 정보 저장
          mapping.fee = fee;
          mapping.priceAdjustment = priceAdjustment;
          mappingsToUpdate.push(mapping);
        }
      }

      // 할인/할증 상태 저장
      mappingPriceAdjustments.set(mapping.id, priceAdjustment);

      // 할인/할증 계산
      if (fee !== null && fee > 0 && priceAdjustment) {
        const productTotalPrice = mapping.product.price * mapping.amount;
        if (priceAdjustment === IPriceAdjustment.DISCOUNT) {
          totalSettleFee -= (productTotalPrice * fee) / 100;
        } else if (priceAdjustment === IPriceAdjustment.ADDITIONAL) {
          totalSettleFee += (productTotalPrice * fee) / 100;
        }
      }
    }

    // 업데이트할 매핑이 있으면 저장
    if (mappingsToUpdate.length > 0) {
      await this.orderProductMappingRepository.save(mappingsToUpdate);
    }

    // ======== 중복번호 제어 체크 시작 ========
    // 할인 적용 → 1건만 허용 (중복 불가)
    // 할인/할증 없음 → duplicatePhoneLimit 만큼 허용 (0이면 무제한)
    // 할증 적용 → 무제한
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    for (const orderMapping of order.orderProductMappings!) {
      const priceAdjustment = mappingPriceAdjustments.get(orderMapping.id);

      // 할증인 경우 중복 체크 스킵 (무제한)
      if (priceAdjustment === IPriceAdjustment.ADDITIONAL) {
        this.logger.debug(`상품 ${orderMapping.productId}: 할증 적용, 중복 체크 스킵 (무제한)`);
        continue;
      }

      // [임시 비활성화] 할인 상품도 중복 체크 스킵 - 복구 시 이 블록 삭제
      if (priceAdjustment === IPriceAdjustment.DISCOUNT) {
        this.logger.debug(`상품 ${orderMapping.productId}: 할인 적용, 중복 체크 임시 비활성화`);
        continue;
      }

      // 허용 개수 결정
      let allowedCount: number;
      // [임시 비활성화] 할인은 위에서 continue 처리됨, 아래는 할인/할증 없음만 해당
      // if (priceAdjustment === IPriceAdjustment.DISCOUNT) {
      //   allowedCount = 1;
      //   this.logger.debug(`상품 ${orderMapping.productId}: 할인 적용, 중복 허용 1건`);
      // } else {
      // 할인/할증 없음인 경우
      if (oneUser.duplicatePhoneLimit === 0) {
        // 0이면 무제한
        this.logger.debug(`상품 ${orderMapping.productId}: 할인/할증 없음, duplicatePhoneLimit=0 (무제한)`);
        continue;
      }
      allowedCount = oneUser.duplicatePhoneLimit;
      this.logger.debug(`상품 ${orderMapping.productId}: 할인/할증 없음, 중복 허용 ${allowedCount}건`);
      // }

      // 현재 주문 내 중복 체크
      const currentOrderPhoneCount = new Map<string, number>();
      for (const od of orderMapping.orderDeliveries) {
        const phone = od.deliveryTarget;
        currentOrderPhoneCount.set(phone, (currentOrderPhoneCount.get(phone) || 0) + 1);
      }

      const duplicateErrors: string[] = [];

      // 현재 주문 내 중복 체크
      for (const [phone, count] of currentOrderPhoneCount.entries()) {
        if (count > allowedCount) {
          let displayPhone = phone;
          try {
            displayPhone = this.cryptoCipher.decryptDeliveryTarget(phone);
          } catch (error) {
            // 복호화 실패 시 원본 사용
          }
          duplicateErrors.push(`- ${displayPhone}: 현재 주문에 ${count}건 포함 (허용: ${allowedCount}건)`);
        }
      }

      // 기존 주문과 중복 체크
      for (const [phone, currentCount] of currentOrderPhoneCount.entries()) {
        let displayPhone = phone;
        try {
          displayPhone = this.cryptoCipher.decryptDeliveryTarget(phone);
        } catch (error) {
          // 복호화 실패 시 원본 사용
        }

        // 하루 기준 동일상품 동일수신처 발송 횟수
        const existingCount = await this.orderDeliveryRepository
          .createQueryBuilder('od')
          .innerJoin('od.orderProductMapping', 'opm')
          .innerJoin('opm.order', 'o')
          .where('o.userId = :userId', { userId: order.userId })
          .andWhere('opm.productId = :productId', { productId: orderMapping.productId })
          .andWhere('od.deliveryTarget = :deliveryTarget', { deliveryTarget: phone })
          .andWhere('o.id != :currentOrderId', { currentOrderId: order.id })
          .andWhere('o.status IN (:...statuses)', {
            statuses: [IOrderStatus.DELIVERY_CONFIRMED, IOrderStatus.DELIVERY_COMPLETE],
          })
          .andWhere('o.createdAt >= :todayStart', { todayStart })
          .andWhere('o.createdAt <= :todayEnd', { todayEnd })
          .getCount();

        const totalCount = existingCount + currentCount;

        this.logger.debug(
          `중복 체크: 상품=${orderMapping.productId}, 수신처=${displayPhone}, 기존=${existingCount}, 현재=${currentCount}, 합계=${totalCount}, 허용=${allowedCount}`,
        );

        if (totalCount > allowedCount) {
          duplicateErrors.push(
            `- ${displayPhone}: 금일 ${existingCount}건 발송 + 현재 ${currentCount}건 = 총 ${totalCount}건 (허용: ${allowedCount}건)`,
          );
        }
      }

      // 중복 에러가 있으면 발송 거절
      if (duplicateErrors.length > 0) {
        // [임시 비활성화] 할인은 위에서 continue 처리되어 여기까지 오지 않음
        // const statusText = priceAdjustment === IPriceAdjustment.DISCOUNT ? '할인 적용 상품' : '일반 상품';
        const statusText = '일반 상품';
        throw new BadRequestException(
          `${statusText}의 중복발송 제한(${allowedCount}건까지 허용)을 초과한 수신처가 발견되었습니다:\n\n${duplicateErrors.join('\n')}`,
        );
      }
    }
    // ======== 중복번호 제어 체크 끝 ========

    // 최종 정산금액 계산
    const finalAmount = order.sendAmount + totalSettleFee;

    if (order.isNewBillingFlow) {
      // === 새 흐름: 발송확정 시 전액 차감 ===

      // 1. effectiveBalance 결정
      const effectiveBalance = isCompanyBalanceMode && oneUser.company
        ? oneUser.company.balance
        : oneUser.balance;

      // 2. 잔여한도 계산
      let remainServiceAmount: number;
      if (oneUser.companyId && oneUser.company) {
        const companyUsers = await this.userRepository.find({
          where: { companyId: oneUser.companyId },
          select: ['id', 'allSettleAmount'],
        });
        const totalAllSettleAmount = companyUsers.reduce((sum, u) => sum + u.allSettleAmount, 0);
        remainServiceAmount = oneUser.company.maximumLimit + effectiveBalance - totalAllSettleAmount;
      } else {
        remainServiceAmount = effectiveBalance - oneUser.allSettleAmount;
      }

      // 3. 한도 체크
      if (finalAmount > remainServiceAmount) {
        throw new BadRequestException(
          `잔여발송한도가 부족하여 발송확정할 수 없습니다. (필요: ${finalAmount.toLocaleString()}원, 가능: ${remainServiceAmount.toLocaleString()}원)`,
        );
      }

      // 4. isSettleBalance 결정 + 차감
      if (finalAmount <= effectiveBalance) {
        if (isCompanyBalanceMode && oneUser.company) {
          oneUser.company.balance -= finalAmount;
        } else {
          oneUser.balance -= finalAmount;
        }
        order.isSettleBalance = true;
      } else {
        oneUser.allSettleAmount += finalAmount;
        order.isSettleBalance = false;
      }

      // 5. 저장
      order.settleAmount = finalAmount;
      await this.userRepository.save(oneUser);
      if (isCompanyBalanceMode && oneUser.company) {
        await this.userCompanyRepository.save(oneUser.company);
      }
    } else {
      // === 기존 흐름: 차액 조정 ===
      const getEffectiveBalance = () =>
        isCompanyBalanceMode && oneUser.company ? oneUser.company.balance : oneUser.balance;
      const setEffectiveBalance = (value: number) => {
        if (isCompanyBalanceMode && oneUser.company) {
          oneUser.company.balance = value;
        } else {
          oneUser.balance = value;
        }
      };
      const addEffectiveBalance = (amount: number) => setEffectiveBalance(getEffectiveBalance() + amount);
      const subtractEffectiveBalance = (amount: number) => setEffectiveBalance(getEffectiveBalance() - amount);

      if (totalSettleFee !== 0) {
        if (totalSettleFee < 0) {
          const discountAmount = Math.abs(totalSettleFee);
          if (order.isSettleBalance) {
            addEffectiveBalance(discountAmount);
          } else {
            oneUser.allSettleAmount -= discountAmount;
          }
          this.logger.debug(
            `할인 적용: orderId=${order.id}, 할인액=${discountAmount}, isSettleBalance=${order.isSettleBalance}`,
          );
        } else if (totalSettleFee > 0) {
          const additionalAmount = totalSettleFee;
          const currentBalance = getEffectiveBalance();

          if (order.isSettleBalance) {
            if (currentBalance >= additionalAmount) {
              subtractEffectiveBalance(additionalAmount);
              this.logger.debug(`할증 적용 (balance 차감): orderId=${order.id}, 할증액=${additionalAmount}`);
            } else {
              const companyMaximumLimit = oneUser.company?.maximumLimit ?? 0;
              const remainingLimit = companyMaximumLimit - oneUser.allSettleAmount;
              const neededFromLimit = additionalAmount - currentBalance;

              if (remainingLimit >= neededFromLimit) {
                oneUser.allSettleAmount += neededFromLimit;
                setEffectiveBalance(0);
                message = 'warning: 잔여발송한도가 부족하여 한도에서 추가 차감되었습니다.';
                this.logger.debug(
                  `할증 적용 (한도 추가 차감): orderId=${order.id}, 할증액=${additionalAmount}, 한도사용=${neededFromLimit}`,
                );
              } else {
                throw new BadRequestException(
                  `잔여발송한도가 부족하여 발송을 진행할 수 없습니다. (필요 금액: ${additionalAmount.toLocaleString()}원, 사용 가능: ${(currentBalance + remainingLimit).toLocaleString()}원)`,
                );
              }
            }
          } else {
            const companyMaxLimit = oneUser.company?.maximumLimit ?? 0;
            const remainingLimit = companyMaxLimit - oneUser.allSettleAmount;

            if (remainingLimit >= additionalAmount) {
              oneUser.allSettleAmount += additionalAmount;
              message = 'warning: 할증 금액이 추가되었습니다.';
              this.logger.debug(`할증 적용 (한도 차감): orderId=${order.id}, 할증액=${additionalAmount}`);
            } else if (currentBalance >= additionalAmount - remainingLimit) {
              const neededFromBalance = additionalAmount - remainingLimit;
              oneUser.allSettleAmount = companyMaxLimit;
              subtractEffectiveBalance(neededFromBalance);
              message = 'warning: 한도가 부족하여 선충전 잔액에서 추가 차감되었습니다.';
              this.logger.debug(
                `할증 적용 (선충전 추가 차감): orderId=${order.id}, 할증액=${additionalAmount}, 선충전사용=${neededFromBalance}`,
              );
            } else {
              throw new BadRequestException(
                `잔여발송한도가 부족하여 발송을 진행할 수 없습니다. (필요 금액: ${additionalAmount.toLocaleString()}원, 사용 가능: ${(currentBalance + remainingLimit).toLocaleString()}원)`,
              );
            }
          }
        }

        await this.userRepository.save(oneUser);
        if (isCompanyBalanceMode && oneUser.company) {
          await this.userCompanyRepository.save(oneUser.company);
        }
      }

      order.settleAmount = finalAmount;
    }
    // ======== 과금 처리 끝 ========

    for (const orderMapping of order.orderProductMappings!) {
      for (const orderDelivery of orderMapping.orderDeliveries) {
        // PIN 발급은 배치에서 실제 발송 시점에 수행
        // 상태를 WAIT으로 변경 (ssgEventId는 이미 deliveryRequest에서 할당됨)
        orderDelivery.status = IOrderDeliveryStatus.WAIT;

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
    const { id, cancelReason } = getBody;

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

    // 과금 대상 userId 결정 (대행주문인 경우 clientUserId, 아니면 userId)
    const billingUserId = order.clientUserId ?? order.userId;

    const oneUser = await this.userRepository.findOneOrFail({
      where: {
        id: billingUserId,
      },
      relations: ['company'],
    });

    // balanceManagementType에 따른 balance 관리 모드 결정
    const isCompanyBalanceMode = oneUser.company?.balanceManagementType === 'COMPANY';

    const now = new Date();
    // 첫 번째 상품의 발송 요청 시간 사용
    const firstMapping = order.orderProductMappings?.[0];
    const sendRequestAtTime = firstMapping?.sendRequestAt?.getTime() ?? 0;
    const nowTime = now.getTime();
    const diffMs = sendRequestAtTime - nowTime;
    const tenMinutesMs = 10 * 60 * 1000;

    if (order.status === IOrderStatus.DELIVERY_REQUEST || order.status === IOrderStatus.REVIEW_COMPLETE) {
      // 주문완료 또는 검토완료 상태에서 취소 허용
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

    // SSG 주문인 경우 이벤트 잔액 복구 (새/기존 흐름 공통)
    if (order.type === IOrderType.SSG) {
      await this.ssgEventService.restoreEventBalance(order.id);
      // ★ addBalance() 호출 삭제 — 아래 통합 블록에서 oneUser 엔티티를 통해 처리
      // 기존 addBalance()는 DB를 직접 수정하지만, 이후 save(oneUser)가 stale 스냅샷으로 덮어씀
    }

    // 환불 금액 결정
    // - 새 흐름: 발송확정(DELIVERY_CONFIRMED) 후에만 settleAmount(할인가) 기준 환불
    //           발송확정 전(DELIVERY_REQUEST, REVIEW_COMPLETE)은 잔액 차감 없었으므로 환불 불필요
    // - 기존 흐름: 항상 정가(totalPrice) 기준 환불
    let refundAmount = 0;
    if (order.isNewBillingFlow) {
      if (order.status === IOrderStatus.DELIVERY_CONFIRMED) {
        refundAmount = order.settleAmount;
      }
    } else {
      refundAmount = totalPrice;
    }

    if (refundAmount > 0) {
      if (order.isSettleBalance) {
        if (isCompanyBalanceMode && oneUser.company) {
          oneUser.company.balance += refundAmount;
        } else {
          oneUser.balance += refundAmount;
        }
        order.isSettleBalance = false;
      } else {
        oneUser.allSettleAmount -= refundAmount;
      }
    }

    order.status = IOrderStatus.DELIVERY_CANCEL;
    order.cancelReason = cancelReason;
    order.canceledAt = new Date();
    await this.orderRepository.save(order);
    await this.orderDeliveryRepository.update(
      { orderProductMappingId: In(orderProductMappingIdList) },
      { status: IOrderDeliveryStatus.CANCEL },
    );
    await this.userRepository.save(oneUser);
    // 회사 레벨 balance 변경 시 company도 저장
    if (isCompanyBalanceMode && oneUser.company) {
      await this.userCompanyRepository.save(oneUser.company);
    }

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
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
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
      if (user.authority === IUserAuthority.OPERATION_ADMIN) {
        queryBuilder = queryBuilder.andWhere(
          '(order.userId = :userId OR order.operationUserId = :userId OR order.clientUserId = :userId)',
          { userId: user.id },
        );
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
          queryBuilder = queryBuilder.andWhere(
            '(userCompany.businessName LIKE :keyword OR clientCompany.businessName LIKE :keyword)',
            { keyword: `%${searchKeyword}%` },
          );
          break;
        case 'MANAGER':
          queryBuilder = queryBuilder.andWhere(
            '(user.personName LIKE :keyword OR clientUser.personName LIKE :keyword)',
            { keyword: `%${searchKeyword}%` },
          );
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
            `(${[
              'userCompany.businessName LIKE :keyword',
              'clientCompany.businessName LIKE :keyword',
              'user.personName LIKE :keyword',
              'clientUser.personName LIKE :keyword',
              'operationUser.personName LIKE :keyword',
              'order.eventName LIKE :keyword',
              'product.name LIKE :keyword',
            ].join(' OR ')})`,
            { keyword: `%${searchKeyword}%` },
          );
          break;
      }
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'order', 'registerAt', startAt, endAt);

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

    const getActualSendAt = (actualSendAt: Date | null) => {
      if (actualSendAt) {
        return dayjs(actualSendAt).format('YYYY/MM/DD HH:mm:ss');
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
        userBusinessName: order.clientUser?.company?.businessName ?? order.user!.company?.businessName ?? '',
        userPersonName: order.clientUser?.personName ?? order.user!.personName,
        eventName: order.eventName,
        productName: productName,
        totalAmount: totalAmount,
        sendAmount: order.sendAmount,
        settleAmount: order.settleAmount,
        status: OrderStatusExcelMapping(order.status),
        sendRequestAt: getActualSendAt(actualSendAt),
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

    // 최대 횟수 (상품별 2회)
    const maxLimitCount = 2;
    const barCode = '999999';

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
      throw new BadRequestException('해당 주문-상품이 존재하지 않습니다.');
    }

    if (orderProductMapping.testDeliveryCount >= maxLimitCount) {
      throw new BadRequestException('테스트발송은 상품당 최대 2회입니다.');
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
    const encryptedDeliveryTarget = this.cryptoCipher.encryptDeliveryTarget(
      PhoneUtil.normalizeDeliveryTarget(deliveryTarget),
    );

    // test_order_delivery 테이블에 저장 (oneSend에서 테스트 발송 여부를 판단하여 PIN 재발급 스킵)
    const testOrderDelivery = new TestOrderDeliveryEntity();
    testOrderDelivery.status = IOrderDeliveryStatus.COMPLETE;
    testOrderDelivery.orderProductMappingId = orderProductMapping.id;
    testOrderDelivery.deliveryMethod = deliveryMethod;
    testOrderDelivery.deliveryTarget = encryptedDeliveryTarget;
    testOrderDelivery.imagePath = imagePath;
    testOrderDelivery.sendRequestAt = new Date();
    testOrderDelivery.expireAt = new Date();
    testOrderDelivery.barCode = barCode;
    testOrderDelivery.personalCode = barCode;

    const savedTestOrderDelivery = await this.testOrderDeliveryRepository.save(testOrderDelivery);
    const testOrderDeliveryId = savedTestOrderDelivery.id;

    const orderDelivery = new OrderDeliveryEntity();
    orderDelivery.deliveryMethod = deliveryMethod;
    orderDelivery.orderProductMappingId = orderProductMapping.id;
    orderDelivery.deliveryTarget = encryptedDeliveryTarget;
    orderDelivery.barCode = barCode;
    orderDelivery.personalCode = barCode;
    orderDelivery.orderProductMapping = orderProductMapping;
    orderDelivery.imagePath = imagePath;
    orderDelivery.expireAt = new Date();

    // 3. 전송 (testOrderDeliveryId로 테스트 발송임을 전달하여 PIN 재발급 스킵)
    const isSuccess = await this.deliveryBatchService.oneSend(orderDelivery, false, testOrderDeliveryId);

    // 발송 실패 시 에러 throw (횟수 증가하지 않음)
    if (!isSuccess) {
      throw new BadRequestException('테스트 발송에 실패했습니다. 수신자 정보를 확인해주세요.');
    }

    // 4. 테스트 발송 횟수 증가 (상품별) - 발송 성공 시에만 증가
    orderProductMapping.testDeliveryCount += 1;
    await this.orderProductMappingRepository.save(orderProductMapping);
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
  async updateEncourageDay(
    user: ILoginUserInfo,
    orderProductMappingId: number,
    getBody: OrderUpdateEncourageDayReqBodyDto,
  ): Promise<void> {
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

  /**
   * 꼬리광고 설정 수정 (발송관리용, 상품별)
   * @param orderProductMappingId order_product_mapping의 id
   */
  async updateTailText(
    user: ILoginUserInfo,
    orderProductMappingId: number,
    getBody: OrderUpdateTailTextReqBodyDto,
  ): Promise<void> {
    const { sendTailText } = getBody;

    const orderProductMapping = await this.orderProductMappingRepository.findOne({
      where: { id: orderProductMappingId },
      relations: ['order'],
    });

    if (!orderProductMapping) {
      throw new BadRequestException('존재하지 않는 상품입니다.');
    }

    // 발송관리에서만 수정 가능 (주문완료 상태 이상)
    if (orderProductMapping.order.status === IOrderStatus.TEMP) {
      throw new BadRequestException('임시저장 상태에서는 꼬리광고를 설정할 수 없습니다.');
    }

    // 빈 문자열인 경우 null로 처리
    orderProductMapping.sendTailText = sendTailText?.trim() || null;
    await this.orderProductMappingRepository.save(orderProductMapping);
  }

  /**
   * 이메일 사용방법 수정 (발송관리용, 상품별)
   * @param orderProductMappingId order_product_mapping의 id
   */
  async updateUseEmailContent(
    user: ILoginUserInfo,
    orderProductMappingId: number,
    getBody: OrderUpdateUseEmailContentReqBodyDto,
  ): Promise<void> {
    const { useEmailContent } = getBody;

    const orderProductMapping = await this.orderProductMappingRepository.findOne({
      where: { id: orderProductMappingId },
      relations: ['order'],
    });

    if (!orderProductMapping) {
      throw new BadRequestException('존재하지 않는 상품입니다.');
    }

    // 발송관리에서만 수정 가능 (주문완료 상태 이상)
    if (orderProductMapping.order.status === IOrderStatus.TEMP) {
      throw new BadRequestException('임시저장 상태에서는 이메일 사용방법을 설정할 수 없습니다.');
    }

    orderProductMapping.useEmailContent = useEmailContent;
    await this.orderProductMappingRepository.save(orderProductMapping);
  }

  /**
   * 상품에 맞는 할인/할증 설정을 찾는 헬퍼 함수
   * - BULK(일괄): 구간 없이 해당 상품군/대분류 전체에 적용
   * - SECTION(구간): 상품 단가가 속하는 구간의 할인율을 전체 가격에 적용
   */
  private findMatchingDiscount(
    product: { price: number; category: string; brand?: { nameKorean: string } | null },
    userDiscounts: UserDiscountEntity[],
  ): UserDiscountEntity | null {
    if (!userDiscounts || userDiscounts.length === 0) {
      return null;
    }

    // 1. BULK(일괄) 방식 먼저 찾기
    const bulkDiscount = userDiscounts.find((d) => {
      if (d.method !== IUserDiscountMethod.BULK) return false;

      if (d.category === IUserDiscountCategory.CATEGORY) {
        return d.group === product.category;
      }
      if (d.category === IUserDiscountCategory.CLASSIFICATION) {
        // primaryCategory는 브랜드명을 저장하므로 brand.nameKorean과 비교
        return d.primaryCategory === product.brand?.nameKorean;
      }
      return false;
    });

    if (bulkDiscount) {
      return bulkDiscount;
    }

    // 2. SECTION(구간) 방식 - 상품 단가 기준으로 해당 구간 찾기
    const sectionDiscounts = userDiscounts.filter((d) => {
      if (d.method !== IUserDiscountMethod.SECTION) return false;
      if (!d.range) return false;

      if (d.category === IUserDiscountCategory.CATEGORY) {
        return d.group === product.category;
      }
      if (d.category === IUserDiscountCategory.CLASSIFICATION) {
        // primaryCategory는 브랜드명을 저장하므로 brand.nameKorean과 비교
        return d.primaryCategory === product.brand?.nameKorean;
      }
      return false;
    });

    if (sectionDiscounts.length === 0) {
      return null;
    }

    // range 값으로 오름차순 정렬
    const sortedDiscounts = sectionDiscounts.sort((a, b) => {
      return parseInt(a.range || '0', 10) - parseInt(b.range || '0', 10);
    });

    const productPrice = product.price;
    let previousUpperBound = 0;

    for (const discount of sortedDiscounts) {
      const rangeValue = parseInt(discount.range || '0', 10);
      let isInRange = false;

      switch (discount.compareCondition) {
        case ICompareCondition.LESS: // 이하
          isInRange = productPrice > previousUpperBound && productPrice <= rangeValue;
          break;
        case ICompareCondition.LESS_THAN: // 미만
          isInRange = productPrice > previousUpperBound && productPrice < rangeValue;
          break;
        case ICompareCondition.MORE: // 이상
          isInRange = productPrice >= rangeValue;
          break;
        case ICompareCondition.MORE_THAN: // 초과
          isInRange = productPrice > rangeValue;
          break;
      }

      if (isInRange) {
        return discount;
      }

      if (discount.compareCondition === ICompareCondition.LESS) {
        previousUpperBound = rangeValue;
      } else if (discount.compareCondition === ICompareCondition.LESS_THAN) {
        previousUpperBound = rangeValue - 1;
      }
    }

    return null;
  }

  /**
   * 발송완료리포트 이메일 발송
   */
  async sendDeliveryCompleteReportEmail(
    getBody: OrderDeliveryCompleteReportEmailReqDto,
    user: ILoginUserInfo,
    ipAddress: string,
  ): Promise<{ success: boolean; message: string }> {
    const { orderId, to, subject, content, pdfBase64, pdfFileName } = getBody;

    // 주문 존재 여부 확인
    const order = await this.orderRepository.findOne({
      where: { id: orderId },
    });

    if (!order) {
      throw new BadRequestException('해당 주문이 존재하지 않습니다.');
    }

    // base64를 Buffer로 변환
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');

    // 이메일 주소 파싱 (첫번째: to, 나머지: cc)
    const emails = to
      .split(',')
      .map((email) => email.trim())
      .filter((email) => email);
    const toEmail = emails[0];
    const ccEmails = emails.length > 1 ? emails.slice(1).join(', ') : undefined;

    // 이메일 발송
    const result = await this.mailSendSmtp.send({
      to: toEmail,
      cc: ccEmails,
      subject,
      content,
      attachments: [
        {
          filename: pdfFileName,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    // 활동 로그 기록
    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/order/delivery-complete/report/email',
      actionType: 'DELIVERY_COMPLETE_REPORT_EMAIL',
      ipAddress,
      statusCode: result.success ? 200 : 500,
      result: result.success ? ActivityLogResult.SUCCESS : ActivityLogResult.FAILURE,
      responseTime: 0,
      requestParams: {
        orderId,
        to: toEmail,
        cc: ccEmails || null,
        subject,
        pdfFileName,
        messageId: result.messageId,
        error: result.error,
      },
      errorMessage: result.error || undefined,
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || '이메일 발송에 실패했습니다.');
    }

    return {
      success: true,
      message: '이메일이 성공적으로 발송되었습니다.',
    };
  }

  /**
   * 거래명세서 이메일 발송
   */
  async sendTransactionStatementReportEmail(
    getBody: OrderTransactionStatementEmailReqDto,
    user: ILoginUserInfo,
    ipAddress: string,
  ): Promise<{ success: boolean; message: string }> {
    const { orderId, to, subject, content, pdfBase64, pdfFileName } = getBody;

    // 주문 존재 여부 확인
    const order = await this.orderRepository.findOne({
      where: { id: orderId },
    });

    if (!order) {
      throw new BadRequestException('해당 주문이 존재하지 않습니다.');
    }

    // base64를 Buffer로 변환
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');

    // 이메일 주소 파싱 (첫번째: to, 나머지: cc)
    const emails = to
      .split(',')
      .map((email) => email.trim())
      .filter((email) => email);
    const toEmail = emails[0];
    const ccEmails = emails.length > 1 ? emails.slice(1).join(', ') : undefined;

    // 이메일 발송
    const result = await this.mailSendSmtp.send({
      to: toEmail,
      cc: ccEmails,
      subject,
      content,
      attachments: [
        {
          filename: pdfFileName,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    // 활동 로그 기록
    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/order/transaction-statement/report/email',
      actionType: 'TRANSACTION_STATEMENT_EMAIL',
      ipAddress,
      statusCode: result.success ? 200 : 500,
      result: result.success ? ActivityLogResult.SUCCESS : ActivityLogResult.FAILURE,
      responseTime: 0,
      requestParams: {
        orderId,
        to: toEmail,
        cc: ccEmails || null,
        subject,
        pdfFileName,
        messageId: result.messageId,
        error: result.error,
      },
      errorMessage: result.error || undefined,
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || '이메일 발송에 실패했습니다.');
    }

    return {
      success: true,
      message: '이메일이 성공적으로 발송되었습니다.',
    };
  }

  /**
   * 파기확약서 이메일 발송
   */
  async sendDestructionCertificateReportEmail(
    getBody: OrderDestructionCertificateEmailReqDto,
    user: ILoginUserInfo,
    ipAddress: string,
  ): Promise<{ success: boolean; message: string }> {
    const { orderId, to, subject, content, pdfBase64, pdfFileName } = getBody;

    // 주문 존재 여부 확인
    const order = await this.orderRepository.findOne({
      where: { id: orderId },
    });

    if (!order) {
      throw new BadRequestException('해당 주문이 존재하지 않습니다.');
    }

    // base64를 Buffer로 변환
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');

    // 이메일 주소 파싱 (첫번째: to, 나머지: cc)
    const emails = to
      .split(',')
      .map((email) => email.trim())
      .filter((email) => email);
    const toEmail = emails[0];
    const ccEmails = emails.length > 1 ? emails.slice(1).join(', ') : undefined;

    // 이메일 발송
    const result = await this.mailSendSmtp.send({
      to: toEmail,
      cc: ccEmails,
      subject,
      content,
      attachments: [
        {
          filename: pdfFileName,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    // 활동 로그 기록
    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/order/destruction-certificate/report/email',
      actionType: 'DESTRUCTION_CERTIFICATE_EMAIL',
      ipAddress,
      statusCode: result.success ? 200 : 500,
      result: result.success ? ActivityLogResult.SUCCESS : ActivityLogResult.FAILURE,
      responseTime: 0,
      requestParams: {
        orderId,
        to: toEmail,
        cc: ccEmails || null,
        subject,
        pdfFileName,
        messageId: result.messageId,
        error: result.error,
      },
      errorMessage: result.error || undefined,
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || '이메일 발송에 실패했습니다.');
    }

    return {
      success: true,
      message: '이메일이 성공적으로 발송되었습니다.',
    };
  }
}
