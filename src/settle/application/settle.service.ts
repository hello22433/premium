import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import {
  SettleGetAdminUserListResDto,
  SettleGetMobileListResDto,
  SettleGetOtherDetailResDto,
  SettleGetOtherListResDto,
  SettleGetPartnerCompanyListResDto,
  SettleGetPerUserDetailResDto,
  SettleGetRemainServiceAmountResDto,
  SettleGetSaleTypeListResDto,
  SettleGetShippingStorageListResDto,
  SettleGetUserDetailResDto,
  SettleGetUserListResDto,
} from '../api/settle.res.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { OrderEntity } from '../../entity/order.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, IsNull, Not, Repository } from 'typeorm';
import {
  SettleCreateOtherSaleReqDto,
  SettleCreateSaleTypeReqDto,
  SettleCreateShippingStorageReqDto,
  SettleGetAdminListReqDto,
  SettleGetMobileListReqQueryDto,
  SettleGetOtherServiceSaleGetDetailReqParamDto,
  SettleGetOtherServiceSaleGetListReqDto,
  SettleGetPartnerCompanyListReqQueryDto,
  SettleGetSaleTypeListReqDto,
  SettleGetShippingStorageListReqDto,
  SettleGetUserDetailReqParamDto,
  SettleGetUserExcelDownloadReqDto,
  SettleGetUserListReqQueryDto,
  SettleGetUserPerDetailReqQueryDto,
  SettleGetUserPerListReqQueryDto,
  SettleMobileExcelDownloadReqDto,
  SettlerUpdateOtherSaleReqDto,
  SettleUpdateUserPerOrderReqDto,
} from '../api/settle.req.dto';
import { SettleUserListViewDto } from '../api/dto/settle.user.list.view.dto';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import { DateDateFormatStr, DateEndMinuteFormatStr, DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { SettlePartnerCompanyListViewDto } from '../api/dto/settle.partner.company.list.view.dto';
import { SettleMobileListViewDto } from '../api/dto/settle.mobile.list.view.dto';
import * as ExcelJS from 'exceljs';
import { join } from 'path';
import * as process from 'node:process';
import { normalizeDate } from '../../util/time.util';
import { SettleProductViewDto } from '../api/dto/settle.product.view.dto';
import { OtherServiceSaleEntity } from '../../entity/other.service.sale.entity';
import { SettleOtherViewDto } from '../api/dto/settle.other.view.dto';
import { OtherServiceSaleProductMappingEntity } from '../../entity/other.service.sale.product.mapping.entity';
import { OtherServiceSaleProductEntity } from '../../entity/other.service.sale.product.entity';
import { UserEntity } from '../../entity/user.entity';
import { IUserAuthority } from '../../user/interface/user.authority';
import { ShippingStorageEntity } from '../../entity/shipping.storage.entity';
import { OtherServiceSaleTypeEntity } from '../../entity/other.service.sale.type.entity';
import { Transactional } from 'typeorm-transactional';
import { ShippingStorageViewDto } from '../api/dto/shipping.storage.view.dto';
import { SaleTypeViewDto } from '../api/dto/sale.type.view.dto';
import { AdminListViewDto } from '../api/dto/admin.list.view.dto';
import { IUserStatus } from '../../user/interface/user.status';
import { SettleOtherProductDetailDto } from '../api/dto/settle.other.product.dto';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { IUserDiscountCategory } from '../../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../../user_discount/interface/user.discount.method';
import { ICompareCondition } from '../../user_discount/interface/compare.condition';
import { SettleUserPerListViewDto } from '../api/dto/settle.user.per.list.view.dto';
import { SettleUserStatusEnum } from '../interface/settle.user.status';
import { SettleUserPerDetailViewDto } from '../api/dto/settle.user.per.detail.view.dto';
import { SettleUserOrderDetailEnum } from '../interface/settle.user.order.detail';
import { UserSettlePeriodConditionEnum } from '../../user/interface/user.settle.period.condition.enum';
import { IUserSettleCondition } from '../../user/interface/user.settle.condition';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';

@Injectable()
export class SettleService {
  constructor(
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(OtherServiceSaleEntity)
    private otherSaleRepository: Repository<OtherServiceSaleEntity>,
    @InjectRepository(OtherServiceSaleProductMappingEntity)
    private otherSaleProductMappingRepository: Repository<OtherServiceSaleProductMappingEntity>,
    @InjectRepository(OtherServiceSaleProductEntity)
    private otherSaleProductRepository: Repository<OtherServiceSaleProductEntity>,
    @InjectRepository(ShippingStorageEntity)
    private shippingStorageRepository: Repository<ShippingStorageEntity>,
    @InjectRepository(UserDiscountEntity)
    private userDiscountRepository: Repository<UserDiscountEntity>,
    @InjectRepository(OtherServiceSaleTypeEntity)
    private saleTypeRepository: Repository<OtherServiceSaleTypeEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private activityLogService: ActivityLogService,
  ) {}

  async getOtherList(getQuery: SettleGetOtherServiceSaleGetListReqDto): Promise<SettleGetOtherListResDto> {
    const {
      startAt,
      endAt,
      personName,
      eventName,
      businessName,
      productName,
      proveEndAt,
      proveStartAt,
      isVat,
      take,
      page,
    } = getQuery;

    let queryBuilder = this.otherSaleRepository
      .createQueryBuilder('sale')
      .innerJoinAndSelect('sale.user', 'user')
      .innerJoinAndSelect('sale.businessUser', 'businessUser')
      .innerJoinAndSelect('sale.otherServiceSaleProductMappings', 'otherServiceSaleProductMappings')
      .innerJoinAndSelect('sale.saleType', 'saleType')
      .innerJoinAndSelect('otherServiceSaleProductMappings.otherServiceSaleProduct', 'product');

    if (personName) {
      queryBuilder = queryBuilder.andWhere('user.personName LIKE :personName', {
        personName: `%${personName}%`,
      });
    }

    if (eventName) {
      queryBuilder = queryBuilder.andWhere('sale.eventName LIKE :eventName', {
        eventName: `%${eventName}%`,
      });
    }

    if (businessName) {
      queryBuilder = queryBuilder.andWhere('businessUser.businessName LIKE :businessName', {
        businessName: `%${businessName}%`,
      });
    }

    if (productName) {
      queryBuilder = queryBuilder.andWhere('product.name LIKE :productName', {
        productName: `%${productName}%`,
      });
    }

    if (isVat) {
      queryBuilder = queryBuilder.andWhere('sale.isVat = :isVat', { isVat });
    }

    if (startAt || endAt) {
      queryBuilder = QueryBuilderDateCondition(queryBuilder, 'sale', 'createdAt', startAt, endAt);
    }

    if (proveStartAt || proveEndAt) {
      queryBuilder = QueryBuilderDateCondition(queryBuilder, 'sale', 'proveAt', proveStartAt, proveEndAt);
    }

    queryBuilder = queryBuilder.orderBy('sale.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder.skip(skip).take(take);
    const [saleList, totalCount] = await queryBuilder.getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const resultList: SettleOtherViewDto[] = [];

    for (const sale of saleList) {
      for (const saleProductMapping of sale.otherServiceSaleProductMappings!) {
        resultList.push({
          id: sale.id,
          registerAt: format(sale.createdAt, DateDateFormatStr),
          personName: sale.user!.personName,
          eventName: sale.eventName,
          productName: saleProductMapping.otherServiceSaleProduct.name,
          proveAt: format(sale.proveAt, DateDateFormatStr),
          businessName: sale.businessUser!.businessName,
          type: sale.saleType.name,
          isVat: sale.isVat,
        });
      }
    }

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  async getOtherDetail(getParam: SettleGetOtherServiceSaleGetDetailReqParamDto): Promise<SettleGetOtherDetailResDto> {
    const { id } = getParam;

    const sale = await this.otherSaleRepository
      .createQueryBuilder('sale')
      .innerJoinAndSelect('sale.user', 'user')
      .innerJoinAndSelect('sale.businessUser', 'businessUser')
      .innerJoinAndSelect('sale.otherServiceSaleProductMappings', 'mapping')
      .innerJoinAndSelect('mapping.otherServiceSaleProduct', 'product')
      .innerJoinAndSelect('sale.saleType', 'saleType')
      .innerJoinAndSelect('sale.shippingStorage', 'shippingStorage')
      .where('sale.id = :id', { id })
      .getOne();

    if (!sale) {
      throw new BadRequestException('기타 서비스 매출 정보를 찾을 수 없습니다.');
    }

    const productList: SettleOtherProductDetailDto[] = sale.otherServiceSaleProductMappings.map((mapping) => {
      const product = mapping.otherServiceSaleProduct;
      return {
        id: product.id,
        code: product.code,
        brandName: product.brandName,
        productName: product.name,
        quantity: mapping.quantity,
        price: product.price,
        totalPrice: mapping.totalPrice,
      };
    });

    return {
      id: sale.id,
      businessUserId: sale.businessUserId,
      userId: sale.userId,
      userName: sale.user.personName,
      businessName: sale.businessUser.businessName,
      businessUserName: sale.businessUser.personName,
      shippingStorageId: sale.shippingStorageId,
      shippingStorageName: sale.shippingStorage.name,
      saleTypeId: sale.saleTypeId,
      saleTypeName: sale.saleType.name,
      isVat: sale.isVat,
      eventName: sale.eventName,
      eventContent: sale.eventContent,
      etc: sale.etc ?? null,
      proveAt: format(sale.proveAt, DateDateFormatStr),
      productList,
    };
  }

  @Transactional()
  async createOtherServiceSale(getBody: SettleCreateOtherSaleReqDto): Promise<void> {
    const {
      businessUserId,
      isVat,
      shippingStorageId,
      userId,
      saleTypeId,
      proveAt,
      eventName,
      eventContent,
      etc,
      productList,
    } = getBody;

    const businessUser = await this.userRepository.findOne({
      where: {
        id: businessUserId,
        authority: IUserAuthority.CORPORATE_ADMIN,
      },
    });

    if (!businessUser) {
      throw new BadRequestException('존재하지 않는 고객사입니다.');
    }

    const user = await this.userRepository.findOne({
      where: {
        id: userId,
        authority: In([IUserAuthority.OPERATION_ADMIN, IUserAuthority.SUPER_ADMIN]),
      },
    });

    if (!user) {
      throw new BadRequestException('존재하지 않는 담당자 입니다.');
    }

    const storage = await this.shippingStorageRepository.findOne({
      where: {
        id: shippingStorageId,
      },
    });

    if (!storage) {
      throw new BadRequestException('존재하지 않는 출하 창고 입니다.');
    }

    const saleType = await this.saleTypeRepository.findOne({
      where: {
        id: saleTypeId,
      },
    });

    if (!saleType) {
      throw new BadRequestException('존재하지 않는 판매유형 입니다.');
    }

    // 1. 기타 서비스 매출 엔티티 생성
    const sale = await this.otherSaleRepository.save(
      this.otherSaleRepository.create({
        businessUserId,
        isVat,
        shippingStorageId,
        userId,
        saleTypeId,
        proveAt: new Date(proveAt),
        eventName,
        eventContent,
        etc,
      }),
    );

    // 2. 상품 리스트 저장
    for (const product of productList) {
      if (product.price * product.quantity !== product.totalPrice) {
        throw new BadRequestException('상품의 단가와 수량의 합이 합계금액(단가 * 수량)과 일치하지 않습니다');
      }

      const existProduct = await this.otherSaleProductRepository.findOne({
        where: { code: product.code },
      });

      if (existProduct) {
        throw new BadRequestException('이미 존재하는 품목 코드입니다');
      }

      // 상품 저장
      const savedProduct = await this.otherSaleProductRepository.save(
        this.otherSaleProductRepository.create({
          code: product.code,
          brandName: product.brandName,
          name: product.productName,
          price: product.price,
        }),
      );

      const totalPrice = Number(product.price) * product.quantity;

      // 매핑 저장
      await this.otherSaleProductMappingRepository.save(
        this.otherSaleProductMappingRepository.create({
          otherServiceSaleId: sale.id,
          otherServiceSaleProductId: savedProduct.id,
          quantity: product.quantity,
          totalPrice,
        }),
      );
    }
  }

  @Transactional()
  async updateOtherServiceSale(getBody: SettlerUpdateOtherSaleReqDto): Promise<void> {
    const {
      saleId,
      businessUserId,
      userId,
      shippingStorageId,
      saleTypeId,
      isVat,
      eventName,
      eventContent,
      etc,
      proveAt,
      productList,
      deleteMappingIds,
    } = getBody;

    const sale = await this.otherSaleRepository.findOne({ where: { id: saleId } });
    if (!sale) {
      throw new BadRequestException('기타 서비스 매출 정보를 찾을 수 없습니다.');
    }

    // 삭제할 상품이 있다면 삭제
    if (deleteMappingIds && deleteMappingIds.length > 0) {
      // 1. 삭제 대상 매핑 전부 조회
      const mappings = await this.otherSaleProductMappingRepository.find({
        where: {
          id: In(deleteMappingIds),
        },
        relations: ['otherServiceSale'],
      });

      // 2. 존재하지 않는 매핑이 있으면 예외
      if (mappings.length !== deleteMappingIds.length) {
        throw new BadRequestException('존재하지 않는 mapping id 가 포함되어 있습니다.');
      }

      // 3. 해당 saleId에 속해 있는 매핑인지 검증
      const invalidMappings = mappings.filter((mapping) => mapping.otherServiceSaleId !== saleId);

      if (invalidMappings.length > 0) {
        throw new BadRequestException('삭제할 매핑 id 중 sale 에 속하지 않는 id 가 있습니다.');
      }

      // 4. 삭제 실행
      await this.otherSaleProductMappingRepository.softDelete(deleteMappingIds);
    }

    if (productList) {
      for (const product of productList) {
        if (product.price * product.quantity !== product.totalPrice) {
          throw new BadRequestException(`단가와 수량의 합이 합계 금액과 맞지 않습니다.`);
        }

        // 상품 코드 중복 확인
        if (!product.mappingId) {
          const existing = await this.otherSaleProductRepository.findOne({
            where: { code: product.code },
          });
          if (existing) {
            throw new BadRequestException('이미 등록된 품목 코드입니다');
          }
        }

        // 상품 저장(수정 또는 추가)
        const savedProduct = await this.otherSaleProductRepository.save(
          this.otherSaleProductRepository.create({
            code: product.code,
            brandName: product.brandName,
            name: product.productName,
            price: product.price,
          }),
        );

        if (product.mappingId) {
          await this.otherSaleProductMappingRepository.update(
            { id: product.mappingId },
            {
              otherServiceSaleId: saleId,
              otherServiceSaleProductId: savedProduct.id,
              quantity: product.quantity,
              totalPrice: product.totalPrice,
            },
          );
        } else {
          const newMapping = this.otherSaleProductMappingRepository.create({
            otherServiceSaleId: saleId,
            otherServiceSaleProductId: savedProduct.id,
            quantity: product.quantity,
            totalPrice: product.totalPrice,
          });
          await this.otherSaleProductMappingRepository.save(newMapping);
        }
      }
    }

    sale.businessUserId = businessUserId;
    sale.userId = userId;
    sale.shippingStorageId = shippingStorageId;
    sale.saleTypeId = saleTypeId;
    sale.isVat = isVat;
    sale.eventName = eventName;
    sale.eventContent = eventContent;
    sale.etc = etc ?? null;
    sale.proveAt = new Date(proveAt);

    await this.otherSaleRepository.save(sale);
  }

  async getShippingStorageList(
    getQuery: SettleGetShippingStorageListReqDto,
  ): Promise<SettleGetShippingStorageListResDto> {
    const { searchText, page, take } = getQuery;

    const queryBuilder = this.shippingStorageRepository.createQueryBuilder('storage');

    if (searchText) {
      queryBuilder.andWhere('storage.name LIKE :searchText OR storage.code LIKE :searchText', {
        searchText: `%${searchText}%`,
      });
    }

    const skip = (page - 1) * take;
    const [storageList, totalCount] = await queryBuilder.skip(skip).take(take).getManyAndCount();
    const totalPage = Math.ceil(totalCount / take);

    const resultList: ShippingStorageViewDto[] = storageList.map((storage) => {
      return {
        id: storage.id,
        code: storage.code,
        name: storage.name,
        type: storage.type,
      };
    });

    return {
      list: resultList,
      totalCount,
      currentPage: page,
      totalPage,
    };
  }

  async getSaleTypeList(getQuery: SettleGetSaleTypeListReqDto): Promise<SettleGetSaleTypeListResDto> {
    const { searchText, page, take } = getQuery;

    const queryBuilder = this.saleTypeRepository.createQueryBuilder('type');

    if (searchText) {
      queryBuilder.andWhere('type.name LIKE :searchText OR type.code LIKE :searchText', {
        searchText: `%${searchText}%`,
      });
    }

    const skip = (page - 1) * take;
    const [saleList, totalCount] = await queryBuilder.skip(skip).take(take).getManyAndCount();
    const totalPage = Math.ceil(totalCount / take);

    const resultList: SaleTypeViewDto[] = saleList.map((sale) => {
      return {
        id: sale.id,
        code: sale.code,
        name: sale.name,
      };
    });

    return {
      list: resultList,
      totalCount,
      currentPage: page,
      totalPage,
    };
  }

  async getAdminUserList(getQuery: SettleGetAdminListReqDto): Promise<SettleGetAdminUserListResDto> {
    const { searchText, page, take } = getQuery;

    const queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .where('user.status = :status', { status: IUserStatus.USED })
      .andWhere('user.authority IN (:...authority)', {
        authority: [IUserAuthority.SUPER_ADMIN, IUserAuthority.OPERATION_ADMIN],
      });

    if (searchText) {
      queryBuilder.andWhere(
        '(user.personName LIKE :searchText OR user.businessName LIKE :searchText OR user.email LIKE :searchText)',
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
        businessName: user.businessName,
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

  async createShippingStorage(getBody: SettleCreateShippingStorageReqDto): Promise<void> {
    const exists = await this.shippingStorageRepository.findOne({
      where: { code: getBody.code },
    });

    if (exists) {
      throw new BadRequestException('이미 존재하는 창고 코드입니다.');
    }

    const storage = this.shippingStorageRepository.create(getBody);
    await this.shippingStorageRepository.save(storage);
  }

  async createSaleType(getBody: SettleCreateSaleTypeReqDto): Promise<void> {
    const exists = await this.saleTypeRepository.findOne({
      where: { code: getBody.code },
    });

    if (exists) {
      throw new BadRequestException('이미 존재하는 판매유형 코드입니다.');
    }

    const type = this.saleTypeRepository.create(getBody);
    await this.saleTypeRepository.save(type);
  }

  async getMobileList(getQuery: SettleGetMobileListReqQueryDto): Promise<SettleGetMobileListResDto> {
    const { startAt, endAt, personName, businessName, eventName, page, take } = getQuery;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.status IN (:...status)', { status: ['DELIVERY_CONFIRMED', 'DELIVERY_COMPLETE'] });

    if (personName) {
      queryBuilder = queryBuilder.andWhere('user.personName LIKE :personName', {
        personName: `%${personName}%`,
      });
    }

    if (eventName) {
      queryBuilder = queryBuilder.andWhere('order.eventName LIKE :eventName', {
        eventName: `%${eventName}%`,
      });
    }

    if (businessName) {
      queryBuilder = queryBuilder.andWhere('user.businessName LIKE :businessName', {
        businessName: `%${businessName}%`,
      });
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'order', 'createdAt', startAt, endAt);
    queryBuilder = queryBuilder.orderBy('order.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder.skip(skip).take(take);
    const [orderList, totalCount] = await queryBuilder.getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const resultList: SettleMobileListViewDto[] = [];

    // TODO 카드 수수료, mms 수수료
    const cardFeePercent = 0;
    const mmsFee = 0;

    for (const order of orderList) {
      for (const orderProductMapping of order.orderProductMappings!) {
        const deliveryAmount = orderProductMapping.amount;
        let tradeAmount = 0;
        let discardAmount = 0;
        let tradeRate = 0;
        let refundAmount = 0;
        let unExchangedAmount = 0;
        let unExchangedPrice = 0;
        let refundPrice = 0;
        let cardFee = 0;
        let deliveryFee = 0;
        let profitAmount = 0;
        let profitRate = 0;

        for (const orderDelivery of orderProductMapping.orderDeliveries!) {
          if (orderDelivery.couponStatus === 'USED') {
            tradeAmount++;
          }
          if (orderDelivery.couponStatus === 'NOT_USED') {
            unExchangedAmount++;
          }
          if (orderDelivery.couponStatus === 'CANCEL') {
            discardAmount++;
            refundAmount++;
          }
        }
        const totalAmount = deliveryAmount * orderProductMapping.product.price;
        tradeRate = +((tradeAmount / deliveryAmount) * 100).toFixed(1);
        unExchangedPrice = orderProductMapping.product.price * unExchangedAmount;
        refundPrice = orderProductMapping.product.price * refundAmount;
        cardFee = totalAmount * (cardFeePercent / 100);
        deliveryFee = totalAmount * (mmsFee / 100);
        profitAmount = unExchangedPrice - (deliveryFee + cardFee);
        profitRate = +((profitAmount / totalAmount) * 100).toFixed(1);

        resultList.push({
          id: order.id,
          businessName: order.user!.businessName,
          productClassification: orderProductMapping.product.classification?.classification ?? '',
          brandNameKorean: orderProductMapping.product.brand!.nameKorean,
          brandNameEnglish: orderProductMapping.product.brand!.nameEnglish,
          personName: order.user!.personName,
          eventName: order.eventName,
          productName: orderProductMapping.product.name,
          deliveryAmount: deliveryAmount,
          tradeAmount: tradeAmount,
          discardAmount: discardAmount,
          tradeRate: tradeRate,
          refundAmount: refundAmount,
          deliveryPrice: order.sendAmount,
          unExchangedPrice: unExchangedPrice,
          refundPrice: refundPrice,
          cardFee: cardFee,
          deliveryFee: deliveryFee,
          profitAmount: profitAmount,
          profitRate: profitRate,
        });
      }
    }

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  async mobileExcelDownload(user: ILoginUserInfo, getQuery: SettleMobileExcelDownloadReqDto) {
    const startTime = Date.now();

    // 비밀번호 확인
    await this.activityLogService.verifyPassword(user.id, getQuery.password);

    const { startAt, endAt, personName, businessName, eventName, downloadReason } = getQuery;

    const now = new Date();
    const nowString = format(now, 'yyyyMMdd');

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.status IN (:...status)', { status: ['DELIVERY_CONFIRMED', 'DELIVERY_COMPLETE'] });

    if (personName) {
      queryBuilder = queryBuilder.andWhere('user.personName LIKE :personName', {
        personName: `%${personName}%`,
      });
    }

    if (eventName) {
      queryBuilder = queryBuilder.andWhere('order.eventName LIKE :eventName', {
        eventName: `%${eventName}%`,
      });
    }

    if (businessName) {
      queryBuilder = queryBuilder.andWhere('user.businessName LIKE :businessName', {
        businessName: `%${businessName}%`,
      });
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'order', 'createdAt', startAt, endAt);
    queryBuilder = queryBuilder.orderBy('order.id', 'DESC');

    const orderList = await queryBuilder.getMany();

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(`sheet1`);

    const resultList: SettleMobileListViewDto[] = [];

    // TODO 카드 수수료, mms 수수료
    const cardFeePercent = 0;
    const mmsFee = 0;

    for (const order of orderList) {
      for (const orderProductMapping of order.orderProductMappings!) {
        const deliveryAmount = orderProductMapping.amount;
        let tradeAmount = 0;
        let discardAmount = 0;
        let tradeRate = 0;
        let refundAmount = 0;
        let unExchangedAmount = 0;
        let unExchangedPrice = 0;
        let refundPrice = 0;
        let cardFee = 0;
        let deliveryFee = 0;
        let profitAmount = 0;
        let profitRate = 0;

        for (const orderDelivery of orderProductMapping.orderDeliveries!) {
          if (orderDelivery.couponStatus === 'USED') {
            tradeAmount++;
          }
          if (orderDelivery.couponStatus === 'NOT_USED') {
            unExchangedAmount++;
          }
          if (orderDelivery.couponStatus === 'CANCEL') {
            discardAmount++;
            refundAmount++;
          }
        }
        const totalAmount = deliveryAmount * orderProductMapping.product.price;
        tradeRate = +((tradeAmount / deliveryAmount) * 100).toFixed(1);
        unExchangedPrice = orderProductMapping.product.price * unExchangedAmount;
        refundPrice = orderProductMapping.product.price * refundAmount;
        cardFee = totalAmount * (cardFeePercent / 100);
        deliveryFee = totalAmount * (mmsFee / 100);
        profitAmount = unExchangedPrice - (deliveryFee + cardFee);
        profitRate = +((profitAmount / totalAmount) * 100).toFixed(1);

        resultList.push({
          id: order.id,
          businessName: order.user!.businessName,
          productClassification: orderProductMapping.product.classification?.classification ?? '',
          brandNameKorean: orderProductMapping.product.brand!.nameKorean,
          brandNameEnglish: orderProductMapping.product.brand!.nameEnglish,
          personName: order.user!.personName,
          eventName: order.eventName,
          productName: orderProductMapping.product.name,
          deliveryAmount: deliveryAmount,
          tradeAmount: tradeAmount,
          discardAmount: discardAmount,
          tradeRate: tradeRate,
          refundAmount: refundAmount,
          deliveryPrice: order.sendAmount,
          unExchangedPrice: unExchangedPrice,
          refundPrice: refundPrice,
          cardFee: cardFee,
          deliveryFee: deliveryFee,
          profitAmount: profitAmount,
          profitRate: profitRate,
        });
      }
    }

    sheet.columns = [
      { header: '번호', key: 'id', width: 10 },
      { header: '고객사명', key: 'businessName', width: 32 },
      { header: '대분류', key: 'productClassification', width: 20 },
      { header: '브랜드명', key: 'brandNameKorean', width: 20 },
      { header: '담당자명', key: 'personName', width: 20 },
      { header: '이벤트명', key: 'eventName', width: 20 },
      { header: '상품명', key: 'productName', width: 32 },
      { header: '발송건수', key: 'deliveryAmount', width: 32 },
      { header: '교환건수', key: 'tradeAmount', width: 32 },
      { header: '폐기건수', key: 'discardAmount', width: 20 },
      { header: '교환율', key: 'tradeRate', width: 20 },
      { header: '환불건수', key: 'refundAmount', width: 20 },
      { header: '발송금액', key: 'deliveryPrice', width: 20 },
      { header: '미교환금액', key: 'unExchangedPrice', width: 20 },
      { header: '환불액', key: 'refundPrice', width: 20 },
      { header: '카드수수료', key: 'cardFee', width: 20 },
      { header: '발송료', key: 'deliveryFee', width: 20 },
      { header: '수익액', key: 'profitAmount', width: 20 },
      { header: '수익률', key: 'profitRate', width: 20 },
    ];

    let id = 1;
    for (const result of resultList) {
      sheet.addRow({
        id: id,
        businessName: result.businessName,
        productClassification: result.productClassification,
        brandNameKorean: result.brandNameKorean,
        personName: result.personName,
        eventName: result.eventName,
        productName: result.productName,
        deliveryAmount: result.deliveryAmount,
        tradeAmount: result.tradeAmount,
        discardAmount: result.discardAmount,
        tradeRate: result.tradeRate,
        refundAmount: result.refundAmount,
        deliveryPrice: result.deliveryPrice,
        unExchangedPrice: result.unExchangedPrice,
        refundPrice: result.refundPrice,
        cardFee: result.cardFee,
        deliveryFee: result.deliveryFee,
        profitAmount: result.profitAmount,
        profitRate: result.profitRate,
      });
      id++;
    }

    const fileName = `수익률_모바일_리스트_${nowString}.xlsx`;
    const filePath = join(process.cwd(), '.', 'public', fileName);

    await workbook.xlsx.writeFile(filePath);

    const endTime = Date.now();
    const responseTime = endTime - startTime;

    // 다운로드 로그 저장
    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/settle/mobile/excel-download',
      actionType: 'EXCEL_DOWNLOAD',
      ipAddress: '',
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime,
      downloadReason,
      recordCount: resultList.length,
      requestParams: { startAt, endAt, personName, businessName, eventName },
    });

    return { fileName, filePath };
  }

  async getPartnerCompanyList(
    getQuery: SettleGetPartnerCompanyListReqQueryDto,
  ): Promise<SettleGetPartnerCompanyListResDto> {
    const { startAt, endAt, settleMethod, businessName, page, take } = getQuery;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.status IN (:...status)', { status: ['DELIVERY_CONFIRMED', 'DELIVERY_COMPLETE'] });

    if (settleMethod) {
      queryBuilder = queryBuilder.andWhere('partnerCompany.settleMethod LIKE :settleMethod', {
        settleMethod: `%${settleMethod}%`,
      });
    }

    if (businessName) {
      queryBuilder = queryBuilder.andWhere('partnerCompany.businessName LIKE :businessName', {
        businessName: `%${businessName}%`,
      });
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'order', 'createdAt', startAt, endAt);
    queryBuilder = queryBuilder.orderBy('order.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder.skip(skip).take(take);
    const [orderList, totalCount] = await queryBuilder.getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const resultList: SettlePartnerCompanyListViewDto[] = [];
    for (const order of orderList) {
      for (const orderProductMapping of order.orderProductMappings!) {
        for (const orderDelivery of orderProductMapping.orderDeliveries) {
          const fee = orderProductMapping.fee ?? 0;
          const feePrice = (orderProductMapping.product.price * fee) / 100;

          // 협력사 정산: 소수점 발생 시 올림 처리
          const settlePrice =
            orderProductMapping.priceAdjustment === 'DISCOUNT'
              ? Math.ceil(orderProductMapping.product.price - feePrice)
              : Math.ceil(orderProductMapping.product.price + feePrice);
          let usePrice = 0;
          let unUsePrice = 0;

          if (orderProductMapping.product.partnerCompany!.type === IPartnerCompanyType.GALAXIA) {
            usePrice = orderProductMapping.product.price - orderDelivery.galaxiaBalance;
            unUsePrice = orderDelivery.galaxiaBalance;
          }

          resultList.push({
            id: order.id,
            registeredAt: format(orderDelivery.sendRequestAt, DateFormatStr),
            partnerCompanyName: orderProductMapping.product.partnerCompany!.businessName,
            userBusinessName: order.user!.businessName,
            eventName: order.eventName,
            code: order.code,
            productNameList: [orderProductMapping.product.name],
            deliveryPrice: orderProductMapping.product.price,
            settlePrice: settlePrice,
            fee: fee,
            feePrice: feePrice,
            usePrice: usePrice,
            unUsePrice: unUsePrice,
            settleMethod: orderProductMapping.product.partnerCompany!.settleMethod,
            isTransfer: orderDelivery.couponStatus === OrderDeliveryCouponStatus.USED,
          });
        }
      }
    }

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  async getUserList(getQuery: SettleGetUserListReqQueryDto): Promise<SettleGetUserListResDto> {
    const { startAt, endAt, isPublished, businessName, personName, eventName, page, take } = getQuery;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.classification', 'classification')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .leftJoinAndSelect('user.userDiscounts', 'userDiscounts')
      .where('order.status IN (:...status)', { status: ['DELIVERY_CONFIRMED', 'DELIVERY_COMPLETE'] });

    if (isPublished === true) {
      queryBuilder.andWhere('order.deliveryCompleteReportCount > 0');
      queryBuilder.andWhere('order.orderCompleteReportCount > 0');
    }

    if (isPublished === false) {
      queryBuilder.andWhere('order.deliveryCompleteReportCount = 0');
      queryBuilder.andWhere('order.orderCompleteReportCount = 0');
    }

    if (businessName) {
      queryBuilder = queryBuilder.andWhere('user.businessName LIKE :businessName', {
        businessName: `%${businessName}%`,
      });
    }

    if (personName) {
      queryBuilder = queryBuilder.andWhere('user.personName LIKE :personName', {
        personName: `%${personName}%`,
      });
    }

    if (eventName) {
      queryBuilder = queryBuilder.andWhere('order.eventName LIKE :eventName', {
        eventName: `%${eventName}%`,
      });
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'order', 'createdAt', startAt, endAt);
    queryBuilder = queryBuilder.orderBy('order.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder.skip(skip).take(take);
    const [orderList, totalCount] = await queryBuilder.getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);
    const resultList: SettleUserListViewDto[] = orderList.map((order) => {
      const productNameList: string[] = [];
      let amount: number = 0;
      let finalSettlePrice = 0;

      const userDiscounts = order.user?.userDiscounts || [];

      // 각 상품별로 할인/할증 적용
      for (const orderProductMapping of order.orderProductMappings!) {
        productNameList.push(orderProductMapping.product.name);
        amount += orderProductMapping.amount;

        const product = orderProductMapping.product;
        const productTotalPrice = product.price * orderProductMapping.amount;

        // 1. orderProductMapping에 이미 fee/priceAdjustment가 저장되어 있으면 그걸 사용
        if (orderProductMapping.fee !== null && orderProductMapping.priceAdjustment !== null) {
          let adjustedPrice = productTotalPrice;
          if (orderProductMapping.fee > 0) {
            if (orderProductMapping.priceAdjustment === IPriceAdjustment.DISCOUNT) {
              adjustedPrice = Math.ceil(productTotalPrice * (100 - orderProductMapping.fee) / 100);
            } else if (orderProductMapping.priceAdjustment === IPriceAdjustment.ADDITIONAL) {
              adjustedPrice = Math.ceil(productTotalPrice * (100 + orderProductMapping.fee) / 100);
            }
          }
          finalSettlePrice += adjustedPrice;
        } else {
          // 2. 저장된 값이 없으면 userDiscounts에서 매칭되는 할인 설정 찾기
          const matchingDiscount = this.findMatchingDiscount(
            {
              price: product.price,
              category: product.category,
              classification: product.classification,
            },
            userDiscounts,
          );

          // 할인/할증 적용
          const discountedPrice = this.applyDiscount(productTotalPrice, matchingDiscount);
          finalSettlePrice += discountedPrice;
        }
      }

      // 첫 번째 상품의 발송 요청 시간 사용
      const firstMapping = order.orderProductMappings?.[0];
      const sendRequestAt = firstMapping?.sendRequestAt ? format(firstMapping.sendRequestAt, DateFormatStr) : null;

      return {
        id: order.id,
        registeredAt: format(order.registerAt, DateFormatStr),
        businessName: order.user!.businessName,
        personName: order.user!.personName,
        eventName: order.eventName,
        productNameList: productNameList,
        amount: amount,
        deliveryPrice: order.sendAmount,
        originalSettlePrice: order.settleAmount,
        settlePrice: finalSettlePrice,
        status: order.status,
        sendRequestAt: sendRequestAt,
        isDeliveryReport: order.deliveryCompleteReportCount > 0,
        isTransactionStatement: order.orderCompleteReportCount > 0,
      };
    });

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  async getUserDetail(getParam: SettleGetUserDetailReqParamDto): Promise<SettleGetUserDetailResDto> {
    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id = :id', { id: getParam.orderId });

    const order = await queryBuilder.getOne();

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    const productList: SettleProductViewDto[] = [];

    if (order.orderProductMappings && order.orderProductMappings.length > 0) {
      for (const orderProductMapping of order.orderProductMappings) {
        // 할인/할증 적용된 단가 계산
        let adjustedPrice = orderProductMapping.product?.price ?? 0;
        if (
          orderProductMapping.fee !== null &&
          orderProductMapping.fee > 0 &&
          orderProductMapping.priceAdjustment
        ) {
          const originalPrice = orderProductMapping.product?.price ?? 0;
          if (orderProductMapping.priceAdjustment === IPriceAdjustment.DISCOUNT) {
            adjustedPrice = Math.ceil(originalPrice * (100 - orderProductMapping.fee) / 100);
          } else if (orderProductMapping.priceAdjustment === IPriceAdjustment.ADDITIONAL) {
            adjustedPrice = Math.ceil(originalPrice * (100 + orderProductMapping.fee) / 100);
          }
        }

        const product = orderProductMapping.product
          ? {
              id: orderProductMapping.product.id,
              code: orderProductMapping.product.code,
              brandName: orderProductMapping.product.brand?.nameKorean ?? '',
              name: orderProductMapping.product.name,
              price: adjustedPrice, // 할인/할증 적용된 단가
              amount: orderProductMapping.amount,
            }
          : null;
        productList.push({
          id: orderProductMapping.id,
          product: product,
        });
      }
    }

    // 첫 번째 상품의 발송 요청 시간 사용
    const firstMapping = order.orderProductMappings?.[0];
    const sendRequestAt = firstMapping && normalizeDate(firstMapping.sendRequestAt) ? format(firstMapping.sendRequestAt!, DateFormatStr) : null;

    return {
      id: order.id,
      userId: order.userId,
      userPersonName: order.user!.personName,
      userBusinessName: order.user!.businessName,
      operationPersonName: order.operationUser?.personName ?? null,
      eventName: order.eventName,
      type: order.type,
      sendRequestAt: sendRequestAt,
      status: order.status,
      productList: productList,
    };
  }

  async getUserExcelDownload(user: ILoginUserInfo, getBody: SettleGetUserExcelDownloadReqDto) {
    const startTime = Date.now();

    // 비밀번호 확인
    await this.activityLogService.verifyPassword(user.id, getBody.password);

    const { startAt, endAt, isPublished, businessName, personName, eventName, downloadReason } = getBody;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.status IN (:...status)', { status: ['DELIVERY_CONFIRMED', 'DELIVERY_COMPLETE'] });

    if (isPublished === true) {
      queryBuilder.andWhere('order.deliveryCompleteReportCount > 0');
      queryBuilder.andWhere('order.orderCompleteReportCount > 0');
    }

    if (isPublished === false) {
      queryBuilder.andWhere('order.deliveryCompleteReportCount = 0');
      queryBuilder.andWhere('order.orderCompleteReportCount = 0');
    }

    if (businessName) {
      queryBuilder = queryBuilder.andWhere('user.businessName LIKE :businessName', {
        businessName: `%${businessName}%`,
      });
    }

    if (personName) {
      queryBuilder = queryBuilder.andWhere('user.personName LIKE :personName', {
        personName: `%${personName}%`,
      });
    }

    if (eventName) {
      queryBuilder = queryBuilder.andWhere('order.eventName LIKE :eventName', {
        eventName: `%${eventName}%`,
      });
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'order', 'createdAt', startAt, endAt);
    queryBuilder = queryBuilder.orderBy('order.id', 'DESC');

    const orderList = await queryBuilder.getMany();

    const resultList: SettleUserListViewDto[] = orderList.map((order) => {
      const productNameList: string[] = [];
      let amount: number = 0;

      for (const orderProductMapping of order.orderProductMappings!) {
        productNameList.push(orderProductMapping.product.name);
        amount += orderProductMapping.amount;
      }

      // 첫 번째 상품의 발송 요청 시간 사용
      const firstMapping = order.orderProductMappings?.[0];
      const sendRequestAt = firstMapping?.sendRequestAt ? format(firstMapping.sendRequestAt, DateEndMinuteFormatStr) : null;

      return {
        id: order.id,
        registeredAt: format(order.registerAt, DateDateFormatStr),
        businessName: order.user!.businessName,
        personName: order.user!.personName,
        eventName: order.eventName,
        productNameList: productNameList,
        amount: amount,
        deliveryPrice: order.sendAmount,
        settlePrice: order.settleAmount,
        originalSettlePrice: order.settleAmount,
        status: order.status,
        sendRequestAt: sendRequestAt,
        isDeliveryReport: order.deliveryCompleteReportCount > 0,
        isTransactionStatement: order.orderCompleteReportCount > 0,
      };
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(`sheet1`);

    sheet.columns = [
      { header: '번호', key: 'id', width: 10 },
      { header: '등록일자', key: 'registeredAt', width: 32 },
      { header: '고객사', key: 'businessName', width: 20 },
      { header: '담당자', key: 'personName', width: 20 },
      { header: '이벤트명', key: 'eventName', width: 20 },
      { header: '상품명', key: 'productNameList', width: 20 },
      { header: '발송수량', key: 'amount', width: 32 },
      { header: '발송금액', key: 'deliveryPrice', width: 32 },
      { header: '정산금액', key: 'settlePrice', width: 32 },
      { header: '진행상태', key: 'status', width: 20 },
      { header: '발송시각', key: 'sendRequestAt', width: 20 },
    ];

    let id = 1;
    for (const result of resultList) {
      let statusMapping = '';
      if (result.status === 'DELIVERY_COMPLETE') {
        statusMapping = '발송완료';
      }

      if (result.status === 'DELIVERY_CONFIRMED') {
        statusMapping = '발송확정';
      }

      sheet.addRow({
        id: id,
        registeredAt: result.registeredAt,
        businessName: result.businessName,
        personName: result.personName,
        eventName: result.eventName,
        productNameList: result.productNameList[0] + `외 ${result.productNameList.length - 1} 건`,
        amount: result.amount,
        deliveryPrice: result.deliveryPrice,
        settlePrice: result.settlePrice,
        status: statusMapping,
        sendRequestAt: result.sendRequestAt,
      });
      id++;
    }

    const now = new Date();
    const nowString = format(now, 'yyyyMMdd');

    const fileName = `고객사별_정산_리스트_${nowString}.xlsx`;
    const filePath = join(process.cwd(), '.', 'public', fileName);

    await workbook.xlsx.writeFile(filePath);

    const endTime = Date.now();
    const responseTime = endTime - startTime;

    // 다운로드 로그 저장
    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/settle/user/excel-download',
      actionType: 'EXCEL_DOWNLOAD',
      ipAddress: '', // Controller에서 추가 필요
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime,
      downloadReason,
      recordCount: resultList.length,
      requestParams: { startAt, endAt, isPublished, businessName, personName, eventName },
    });

    return { fileName, filePath, recordCount: resultList.length };
  }

  async getUserPerList(getDto: SettleGetUserPerListReqQueryDto) {
    const { startAt, endAt, userPersonName, userBusinessName, take, page, status } = getDto;

    const queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .innerJoinAndSelect('user.orders', 'orders')
      .innerJoinAndSelect('orders.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries');

    QueryBuilderDateCondition(queryBuilder, 'orderDeliveries', 'sendRequestAt', startAt, endAt);

    if (userPersonName) {
      queryBuilder.andWhere('user.personName LIKE :userPersonName', { userPersonName: `%${userPersonName}%` });
    }

    if (userBusinessName) {
      queryBuilder.andWhere('user.businessName LIKE :userBusinessName', { userBusinessName: `%${userBusinessName}%` });
    }

    if (status) {
      if (status === 'ACTIVE') {
        queryBuilder.andWhere(`user.maximumLimit + user.balance - user.allSettleAmount + user.serviceAmount > 0`);
      }

      if (status === 'STOP') {
        queryBuilder.andWhere(`user.maximumLimit + user.balance - user.allSettleAmount + user.serviceAmount <= 0`);
      }
    }

    queryBuilder.skip((page - 1) * take).take(take);
    queryBuilder.orderBy('user.id', 'DESC');

    const [userList, totalCount] = await queryBuilder.getManyAndCount();

    const result: SettleUserPerListViewDto[] = userList.map((user) => {
      let overdueCount = 0;
      let overdueAmount = 0;
      for (const order of user.orders!) {
        if (order.status === 'DELIVERY_COMPLETE' && order.settleStatus === 'UNSETTLE_OVERDUE') {
          overdueCount += 1;
          overdueAmount += order.sendAmount;
        }
      }

      const remainServiceAmount = user.maximumLimit + user.balance - user.allSettleAmount + user.serviceAmount;

      return {
        id: user.id,
        email: user.email,
        businessName: user.businessName,
        personName: user.personName,
        settleCondition: user.settleCondition,
        settlePeriodCondition: user.settlePeriodCondition,
        settlePeriodCount: user.settlePeriodCount,
        maximumLimit: user.maximumLimit,
        serviceAmount: user.allSettleAmount,
        overdueCount: overdueCount,
        overdueAmount: overdueAmount,
        balance: user.balance,
        remainServiceAmount: remainServiceAmount,
        status: remainServiceAmount > 0 ? SettleUserStatusEnum.ACTIVE : SettleUserStatusEnum.STOP,
      };
    });

    return {
      list: result,
      totalCount,
      totalPage: Math.ceil(totalCount / take),
      currentPage: page,
    };
  }

  async getUserPerDetail(getDto: SettleGetUserPerDetailReqQueryDto): Promise<SettleGetPerUserDetailResDto> {
    const { userId, startAt, endAt, userBusinessName, userPersonName, settleStatus, take, page } = getDto;

    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .where('order.userId = :userId', { userId: userId })
      .andWhere('order.status IN (:...status)', { status: ['DELIVERY_CONFIRMED', 'DELIVERY_COMPLETE'] });

    QueryBuilderDateCondition(queryBuilder, 'order', 'sendRequestAt', startAt, endAt);

    if (userBusinessName) {
      queryBuilder.andWhere('user.businessName LIKE :userBusinessName', {
        userBusinessName: `%${userBusinessName}%`,
      });
    }
    if (userPersonName) {
      queryBuilder.andWhere('user.personName LIKE :userPersonName', { userPersonName: `%${userPersonName}%` });
    }

    if (settleStatus) {
      if (settleStatus === 'UNSETTLE_NORMAL') {
        queryBuilder.andWhere(
          new Brackets((qb) => {
            qb.where('order.settleStatus = :settleStatus', { settleStatus: settleStatus }).orWhere(
              'order.settleStatus IS NULL',
            );
          }),
        );
      } else {
        queryBuilder.andWhere('order.settleStatus = :settleStatus', { settleStatus: settleStatus });
      }
    }

    queryBuilder.skip((page - 1) * take).take(take);
    queryBuilder.orderBy('order.id', 'DESC');

    const [orderList, totalCount] = await queryBuilder.getManyAndCount();

    const resultList: SettleUserPerDetailViewDto[] = orderList.map((order) => {
      let productName = '';
      const firstMapping = order.orderProductMappings?.[0];
      if (order.orderProductMappings && order.orderProductMappings.length > 0) {
        productName = order.orderProductMappings[0].product.name;
        const orderProductMappingsLength = order.orderProductMappings.length;
        if (orderProductMappingsLength - 1 > 0) {
          productName += `외 ${orderProductMappingsLength - 1}건`;
        }
      }

      // 첫 번째 상품의 발송 요청 시간 사용
      const sendRequestAt = firstMapping?.sendRequestAt ? format(firstMapping.sendRequestAt, DateFormatStr) : null;

      return {
        id: order.id,
        userBusinessName: order.user!.businessName,
        userPersonName: order.user!.personName,
        sendRequestAt: sendRequestAt,
        eventName: order.eventName,
        productName: productName,
        settleAmount: order.sendAmount,
        settleDiscountAmount: order.settleAmount,
        isOrderCompleteReport: order.orderCompleteReportCount > 0,
        settleStatus: order.settleStatus,
        isSettleComplete: order.isSettleComplete,
      };
    });

    return { list: resultList, totalCount, totalPage: Math.ceil(totalCount / take), currentPage: page };
  }

  async updateUserPerOrder(getDto: SettleUpdateUserPerOrderReqDto) {
    const { orderId, settleStatus } = getDto;

    const order = await this.orderRepository.findOne({
      where: {
        id: orderId,
      },
    });

    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    const user = await this.userRepository.findOne({
      where: {
        id: order.userId,
      },
    });

    if (!user) {
      throw new InternalServerErrorException('유저가 존재하지 않습니다.');
    }

    if (order.settleStatus === SettleUserOrderDetailEnum.SETTLE_COMPLETE) {
      throw new BadRequestException('이미 정산이 완료된 주문입니다.');
      // if (settleStatus !== SettleUserOrderDetailEnum.SETTLE_COMPLETE) {
      //   user.allSettleAmount -= order.settleAmount;
      //   order.isSettleComplete = false;
      // }
    }

    order.settleStatus = settleStatus;

    if (settleStatus === SettleUserOrderDetailEnum.SETTLE_COMPLETE) {
      order.isSettleComplete = true;
      user.allSettleAmount -= order.settleAmount;
    }

    await this.userRepository.save(user);
    await this.orderRepository.save(order);

    return;
  }

  @Transactional()
  async syncSettleOverdue() {
    const userList = await this.userRepository.find({
      where: {
        settlePeriodCount: Not(IsNull()),
        settlePeriodCondition: Not(IsNull()),
      },
    });

    for (const user of userList) {
      // 초과하는 날짜 기준
      const orderList = await this.orderRepository
        .createQueryBuilder('order')
        .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
        .where('order.userId = :userId', { userId: user.id })
        .andWhere(
          new Brackets((qb) => {
            qb.where('order.settleStatus IS NULL').orWhere('order.settleStatus = :settleStatus', {
              settleStatus: SettleUserOrderDetailEnum.UNSETTLE_NORMAL,
            });
          }),
        )
        .andWhere('order.status = :status', { status: 'DELIVERY_COMPLETE' })
        .getMany();

      const now = new Date();
      let conditionDate = new Date();
      const updateOrderIdList: number[] = [];

      if (user.settlePeriodCondition === UserSettlePeriodConditionEnum.CURRENT_MONTH) {
        const year = now.getFullYear();
        const month = now.getMonth();

        conditionDate = new Date(year, month, user.settlePeriodCount!);
      }

      if (user.settlePeriodCondition === UserSettlePeriodConditionEnum.NEXT_MONTH) {
        const year = now.getFullYear();
        const month = now.getMonth() + 1;

        conditionDate = new Date(year, month, user.settlePeriodCount!);
      }

      if (user.settlePeriodCondition === UserSettlePeriodConditionEnum.NEXT_MONTH_AFTER) {
        const year = now.getFullYear();
        const month = now.getMonth() + 2;

        conditionDate = new Date(year, month, user.settlePeriodCount!);
      }

      for (const order of orderList) {
        // 첫 번째 상품의 발송 요청 시간 사용
        const firstMapping = order.orderProductMappings?.[0];
        const sendRequestAt = firstMapping?.sendRequestAt;
        if (!sendRequestAt) continue;

        if (user.settlePeriodCondition === UserSettlePeriodConditionEnum.DELIVERY_DATE) {
          const year = sendRequestAt.getFullYear();
          const month = sendRequestAt.getMonth();
          const day = sendRequestAt.getDate() + user.settlePeriodCount!;
          conditionDate = new Date(year, month, day);

          if (now >= conditionDate) {
            updateOrderIdList.push(order.id);
          }
        }

        if (
          user.settlePeriodCondition !== UserSettlePeriodConditionEnum.DELIVERY_DATE &&
          conditionDate >= sendRequestAt
        ) {
          updateOrderIdList.push(order.id);
        }
      }

      if (updateOrderIdList.length > 0) {
        await this.orderRepository.update(updateOrderIdList, {
          settleStatus: SettleUserOrderDetailEnum.UNSETTLE_OVERDUE,
        });
      }
    }
  }

  /**
   * 로그인한 사용자의 잔여 발송 한도 조회
   * - 선정산(PRE_PAYMENT): 최대한도 = 선충전잔액 (balance)
   * - 후정산(POST_PAYMENT): 최대한도 = 선충전잔액 + 여신한도 (balance + maximumLimit)
   * @param user 로그인한 사용자 정보
   * @returns 잔여 발송 한도 정보
   */
  async getRemainServiceAmount(user: ILoginUserInfo): Promise<SettleGetRemainServiceAmountResDto> {
    // 사용자 정보 조회
    const userEntity = await this.userRepository.findOne({
      where: { id: user.id },
      relations: ['orders'],
    });

    if (!userEntity) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }

    // 정산기일 초과 금액 계산
    let overdueAmount = 0;
    if (userEntity.orders) {
      for (const order of userEntity.orders) {
        if (order.status === 'DELIVERY_COMPLETE' && order.settleStatus === 'UNSETTLE_OVERDUE') {
          overdueAmount += order.sendAmount;
        }
      }
    }

    // 발송금액 = 서비스금액 + 정산기일초과금액
    const deliveryAmount = userEntity.serviceAmount + overdueAmount;

    // 정산 조건에 따른 최대 한도 계산
    // - 선정산(PRE_PAYMENT): 최대한도 = 선충전잔액
    // - 후정산(POST_PAYMENT): 최대한도 = 선충전잔액 + 여신한도
    let effectiveMaxLimit: number;
    if (userEntity.settleCondition === IUserSettleCondition.PRE_PAYMENT) {
      effectiveMaxLimit = userEntity.balance;
    } else {
      effectiveMaxLimit = userEntity.balance + userEntity.maximumLimit;
    }

    // 잔여발송한도 = 유효최대한도 - 주문금액
    const remainServiceAmount = effectiveMaxLimit - userEntity.allSettleAmount;

    return {
      maximumLimit: userEntity.maximumLimit,
      balance: userEntity.balance,
      serviceAmount: userEntity.serviceAmount,
      overdueAmount: overdueAmount,
      allSettleAmount: userEntity.allSettleAmount,
      remainServiceAmount: remainServiceAmount,
    };
  }

  /**
   * 상품에 맞는 할인/할증 설정을 찾는 헬퍼 함수
   * - BULK(일괄): 구간 없이 해당 상품군/대분류 전체에 적용
   * - SECTION(구간): 상품 단가가 속하는 구간의 할인율을 전체 가격에 적용
   *   예: 5000원이하 10%, 10000원이하 2% → 6000원 상품은 2% 할인 (전체 6000원에 적용)
   */
  private findMatchingDiscount(
    product: { price: number; category: string; classification?: { classification: string } | null },
    userDiscounts: UserDiscountEntity[],
  ): UserDiscountEntity | null {
    if (!userDiscounts || userDiscounts.length === 0) {
      return null;
    }

    // 1. BULK(일괄) 방식 먼저 찾기 - 구간 없이 바로 적용
    const bulkDiscount = userDiscounts.find((d) => {
      if (d.method !== IUserDiscountMethod.BULK) return false;

      if (d.category === IUserDiscountCategory.CATEGORY) {
        return d.group === product.category;
      }
      if (d.category === IUserDiscountCategory.CLASSIFICATION) {
        return d.primaryCategory === product.classification?.classification;
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
        return d.primaryCategory === product.classification?.classification;
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

    // 누적 구간: [0~5000], [5001~10000], [10001~20000] ...
    for (const discount of sortedDiscounts) {
      const rangeValue = parseInt(discount.range || '0', 10);

      // 비교조건에 따른 범위 체크
      let isInRange = false;

      switch (discount.compareCondition) {
        case ICompareCondition.LESS: // 이하 (<=)
          isInRange = productPrice > previousUpperBound && productPrice <= rangeValue;
          break;
        case ICompareCondition.LESS_THAN: // 미만 (<)
          isInRange = productPrice > previousUpperBound && productPrice < rangeValue;
          break;
        case ICompareCondition.MORE: // 이상 (>=)
          isInRange = productPrice >= rangeValue;
          break;
        case ICompareCondition.MORE_THAN: // 초과 (>)
          isInRange = productPrice > rangeValue;
          break;
      }

      if (isInRange) {
        return discount;
      }

      // 다음 구간을 위해 이전 상한값 업데이트 (이하/미만 조건일 때)
      if (discount.compareCondition === ICompareCondition.LESS) {
        previousUpperBound = rangeValue;
      } else if (discount.compareCondition === ICompareCondition.LESS_THAN) {
        previousUpperBound = rangeValue - 1;
      }
    }

    return null;
  }

  /**
   * 상품 가격에 할인/할증 적용
   */
  private applyDiscount(price: number, discount: UserDiscountEntity | null): number {
    if (!discount) {
      return price;
    }

    if (discount.priceAdjustment === IPriceAdjustment.DISCOUNT) {
      return (price * (100 - discount.pricePercent)) / 100;
    } else if (discount.priceAdjustment === IPriceAdjustment.ADDITIONAL) {
      return (price * (100 + discount.pricePercent)) / 100;
    }

    return price;
  }
}
