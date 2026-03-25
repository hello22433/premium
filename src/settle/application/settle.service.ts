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
  SettleGetUserSummaryResDto,
  SettleGetUserIdsResDto,
  SettleGetUserIdsItemDto,
  SettleGetGalaxiaListResDto,
} from '../api/settle.res.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { OrderEntity } from '../../entity/order.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, IsNull, Not, Repository, SelectQueryBuilder } from 'typeorm';
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
  SettleGetUserDetailMultipleReqQueryDto,
  SettlePostUserDetailMultipleReqBodyDto,
  SettleGetUserIdsReqQueryDto,
  SettleGetUserExcelDownloadReqDto,
  SettleGetUserListReqQueryDto,
  SettleGetUserSummaryReqQueryDto,
  SettleGetUserPerDetailReqQueryDto,
  SettleGetUserPerListReqQueryDto,
  SettleMobileExcelDownloadReqDto,
  SettlePartnerCompanyExcelDownloadReqDto,
  SettlerUpdateOtherSaleReqDto,
  SettleUpdateUserPerOrderReqDto,
  SettleGetGalaxiaListReqQueryDto,
  SettleGalaxiaExcelDownloadReqDto,
} from '../api/settle.req.dto';
import {
  SettleUserDetailMultipleDto,
  SettleProductMultipleDetailDto,
} from '../api/dto/settle.user.detail.multiple.dto';
import { SettleUserListViewDto } from '../api/dto/settle.user.list.view.dto';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import {
  DateCompactStr,
  DateDateFormatStr,
  DateEndMinuteFormatStr,
  DateFormatStr,
  TimeCompactStr,
  TimeFormatStr,
} from '../../common/domain/date.format.str';
import { format, subMonths } from 'date-fns';
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
import { OrderDeliveryCouponStatus, couponStatusToKorean } from '../../delivery/interface/order.delivery.coupon.status';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { findMatchingDiscount } from '../../user_discount/domain/discount.matcher';
import { SettleUserPerListViewDto } from '../api/dto/settle.user.per.list.view.dto';
import { SettleUserStatusEnum } from '../interface/settle.user.status';
import { SettleUserPerDetailViewDto } from '../api/dto/settle.user.per.detail.view.dto';
import { SettleUserOrderDetailEnum } from '../interface/settle.user.order.detail';
import { UserSettlePeriodConditionEnum } from '../../user/interface/user.settle.period.condition.enum';
import { IUserSettleCondition } from '../../user/interface/user.settle.condition';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogActionType } from '../../activity_log/interface/activity.log.action.type';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';
import { ActivityLogEntity } from '../../entity/activity.log.entity';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { GalaxiaBarcodeLogEntity } from '../../entity/galaxia.barcode.log.entity';
import { SettleGalaxiaListViewDto } from '../api/dto/settle.galaxia.list.view.dto';
import { IProductSettleMethod } from '../../product/interface/product.settle.method';

@Injectable()
export class SettleService {
  constructor(
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
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
    @InjectRepository(GalaxiaBarcodeLogEntity)
    private galaxiaBarcodeLogRepository: Repository<GalaxiaBarcodeLogEntity>,
    @InjectRepository(ActivityLogEntity)
    private activityLogRepository: Repository<ActivityLogEntity>,
    private activityLogService: ActivityLogService,
    private cryptoCipher: CryptoCipher,
  ) { }

  /**
   * 기본 조회 기간 적용 (startAt/endAt 미지정 시 최근 1개월)
   */
  private applyDefaultDateRange(startAt?: string, endAt?: string): { startAt: string; endAt: string } {
    const now = new Date();
    return {
      startAt: startAt || format(subMonths(now, 1), "yyyy-MM-dd'T'00:00:00"),
      endAt: endAt || format(now, "yyyy-MM-dd'T'23:59:59"),
    };
  }

  private getGalaxiaSettlementTargetAmount(
    settleMethod: IProductSettleMethod,
    usedAmount: number,
    productPrice: number,
  ): number {
    if (settleMethod === 'PER_EXCHANGE') {
      return productPrice;
    }

    return usedAmount;
  }

  async getOtherList(getQuery: SettleGetOtherServiceSaleGetListReqDto): Promise<SettleGetOtherListResDto> {
    const defaultDate = this.applyDefaultDateRange(getQuery.startAt, getQuery.endAt);
    const {
      personName,
      eventName,
      businessName,
      productName,
      proveEndAt,
      proveStartAt,
      isVat,
      take,
      page,
      searchKeyword,
    } = getQuery;
    const { startAt, endAt } = defaultDate;

    let queryBuilder = this.otherSaleRepository
      .createQueryBuilder('sale')
      .innerJoinAndSelect('sale.user', 'user')
      .innerJoinAndSelect('sale.businessUser', 'businessUser')
      .leftJoinAndSelect('businessUser.company', 'businessCompany')
      .innerJoinAndSelect('sale.otherServiceSaleProductMappings', 'otherServiceSaleProductMappings')
      .innerJoinAndSelect('sale.saleType', 'saleType')
      .innerJoinAndSelect('otherServiceSaleProductMappings.otherServiceSaleProduct', 'product');

    if (searchKeyword) {
      queryBuilder = queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('user.personName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('sale.eventName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('businessCompany.businessName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('product.name LIKE :keyword', { keyword: `%${searchKeyword}%` });
        }),
      );
    }

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
      queryBuilder = queryBuilder.andWhere('businessCompany.businessName LIKE :businessName', {
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

    // 등록일자 필터: 사용자가 직접 입력했거나, 다른 날짜 필터가 전혀 없을 때만 기본값 적용
    if (getQuery.startAt || getQuery.endAt || (!proveStartAt && !proveEndAt)) {
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
          businessName: sale.businessUser!.company?.businessName ?? '',
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
      businessName: sale.businessUser.company?.businessName ?? '',
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
      .leftJoinAndSelect('user.company', 'company')
      .where('user.status = :status', { status: IUserStatus.USED })
      .andWhere('user.authority IN (:...authority)', {
        authority: [IUserAuthority.SUPER_ADMIN, IUserAuthority.OPERATION_ADMIN],
      });

    if (searchText) {
      queryBuilder.andWhere(
        '(user.personName LIKE :searchText OR company.businessName LIKE :searchText OR user.email LIKE :searchText)',
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
    const defaultDate = this.applyDefaultDateRange(getQuery.startAt, getQuery.endAt);
    const { personName, businessName, eventName, page, take, searchKeyword } = getQuery;
    const { startAt, endAt } = defaultDate;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.status IN (:...status)', { status: ['DELIVERY_CONFIRMED', 'DELIVERY_COMPLETE'] });

    if (searchKeyword) {
      queryBuilder = queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('userCompany.businessName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('clientCompany.businessName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('user.personName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('clientUser.personName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('order.eventName LIKE :keyword', { keyword: `%${searchKeyword}%` });
        }),
      );
    }


    if (personName) {
      queryBuilder = queryBuilder.andWhere(
        '(user.personName LIKE :personName OR clientUser.personName LIKE :personName)',
        { personName: `%${personName}%` },
      );
    }

    if (eventName) {
      queryBuilder = queryBuilder.andWhere('order.eventName LIKE :eventName', {
        eventName: `%${eventName}%`,
      });
    }

    if (businessName) {
      queryBuilder = queryBuilder.andWhere(
        '(userCompany.businessName LIKE :businessName OR clientCompany.businessName LIKE :businessName)',
        { businessName: `%${businessName}%` },
      );
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
          businessName: order.clientUser?.company?.businessName ?? order.user!.company?.businessName ?? '',
          productClassification: orderProductMapping.product.classification?.classification ?? '',
          brandNameKorean: orderProductMapping.product.brand!.nameKorean,
          brandNameEnglish: orderProductMapping.product.brand!.nameEnglish,
          personName: order.clientUser?.personName ?? order.user!.personName,
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

    const defaultDate = this.applyDefaultDateRange(getQuery.startAt, getQuery.endAt);
    const { personName, businessName, eventName, downloadReason, searchKeyword } = getQuery;
    const { startAt, endAt } = defaultDate;

    const now = new Date();
    const nowString = format(now, 'yyyyMMdd');

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.status IN (:...status)', { status: ['DELIVERY_CONFIRMED', 'DELIVERY_COMPLETE'] });

    if (searchKeyword) {
      queryBuilder = queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('userCompany.businessName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('clientCompany.businessName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('user.personName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('clientUser.personName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('order.eventName LIKE :keyword', { keyword: `%${searchKeyword}%` });
        }),
      );
    }

    if (personName) {
      queryBuilder = queryBuilder.andWhere(
        '(user.personName LIKE :personName OR clientUser.personName LIKE :personName)',
        { personName: `%${personName}%` },
      );
    }

    if (eventName) {
      queryBuilder = queryBuilder.andWhere('order.eventName LIKE :eventName', {
        eventName: `%${eventName}%`,
      });
    }

    if (businessName) {
      queryBuilder = queryBuilder.andWhere(
        '(userCompany.businessName LIKE :businessName OR clientCompany.businessName LIKE :businessName)',
        { businessName: `%${businessName}%` },
      );
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
          businessName: order.clientUser?.company?.businessName ?? order.user!.company?.businessName ?? '',
          productClassification: orderProductMapping.product.classification?.classification ?? '',
          brandNameKorean: orderProductMapping.product.brand!.nameKorean,
          brandNameEnglish: orderProductMapping.product.brand!.nameEnglish,
          personName: order.clientUser?.personName ?? order.user!.personName,
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
    const defaultDate = this.applyDefaultDateRange(getQuery.startAt, getQuery.endAt);
    const { settleMethod, businessName, page, take } = getQuery;
    const { startAt, endAt } = defaultDate;

    // OrderDelivery 기준으로 직접 쿼리하여 DB 레벨 페이징 적용
    let queryBuilder = this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('partnerCompany.userDiscounts', 'partnerDiscounts')
      .leftJoinAndSelect('product.brand', 'brand')
      .where('order.status IN (:...status)', { status: ['DELIVERY_CONFIRMED', 'DELIVERY_COMPLETE'] })
      .andWhere(
        new Brackets((qb) =>
          qb
            .where('partnerCompany.type != :galaxiaType', { galaxiaType: IPartnerCompanyType.GALAXIA })
            .orWhere('partnerCompany.type IS NULL'),
        ),
      );

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

    // 날짜 조건 적용 (order.createdAt 기준)
    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'order', 'createdAt', startAt, endAt);

    // 총 개수 조회 (페이징 전)
    const totalCount = await queryBuilder.getCount();
    const totalPage = Math.ceil(totalCount / take);

    // DB 레벨 페이징 적용
    const skip = (page - 1) * take;
    queryBuilder = queryBuilder
      .orderBy('orderDelivery.id', 'DESC')
      .skip(skip)
      .take(take);

    const orderDeliveryList = await queryBuilder.getMany();

    // 결과 변환
    const resultList: SettlePartnerCompanyListViewDto[] = orderDeliveryList.map((orderDelivery) => {
      const orderProductMapping = orderDelivery.orderProductMapping;
      const order = orderProductMapping.order;
      const product = orderProductMapping.product;
      const partnerCompany = product.partnerCompany!;
      const partnerDiscounts = partnerCompany.userDiscounts || [];

      // 협력사 할인옵션에서 매칭되는 할인 찾기
      const matchingDiscount = findMatchingDiscount(
        {
          price: product.price,
          category: product.category,
          brand: product.brand,
        },
        partnerDiscounts,
      );

      // 협력사별 정산은 협력사 할인옵션만 적용 (없으면 수수료율 0%)
      let fee: number;
      let priceAdjustment: string;
      if (matchingDiscount) {
        fee = matchingDiscount.pricePercent;
        priceAdjustment = matchingDiscount.priceAdjustment;
      } else {
        // 협력사 할인옵션이 없으면 수수료 없음 (정상가 = 공급가)
        fee = 0;
        priceAdjustment = 'DISCOUNT';
      }

      const feePrice = (product.price * fee) / 100;

      // 협력사 정산: 소수점 발생 시 올림 처리
      const settlePrice =
        priceAdjustment === 'DISCOUNT'
          ? Math.ceil(product.price - feePrice)
          : Math.ceil(product.price + feePrice);

      return {
        id: order.id,
        registeredAt: format(orderDelivery.sendRequestAt, DateFormatStr),
        partnerCompanyName: partnerCompany.businessName,
        userBusinessName: order.clientUser?.company?.businessName ?? order.user!.company?.businessName ?? '',
        eventName: order.eventName,
        code: order.code,
        productNameList: [product.name],
        deliveryPrice: product.price,
        settlePrice: settlePrice,
        fee: fee,
        feePrice: feePrice,
        usePrice: 0,
        unUsePrice: 0,
        settleMethod: partnerCompany.settleMethod,
        isTransfer: orderDelivery.couponStatus === OrderDeliveryCouponStatus.USED,
      };
    });

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  async partnerCompanyExcelDownload(user: ILoginUserInfo, body: SettlePartnerCompanyExcelDownloadReqDto) {
    const startTime = Date.now();

    // 비밀번호 확인
    await this.activityLogService.verifyPassword(user.id, body.password);

    const defaultDate = this.applyDefaultDateRange(body.startAt, body.endAt);
    const { settleMethod, businessName, downloadReason } = body;
    const { startAt, endAt } = defaultDate;

    const now = new Date();
    const nowString = format(now, 'yyyyMMdd');

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('partnerCompany.userDiscounts', 'partnerDiscounts')
      .leftJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .leftJoinAndSelect('orderDeliveries.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.partnerCompany', 'choicePartnerCompany')
      .leftJoinAndSelect('choiceSelectProduct.brand', 'choiceBrand')
      .where('order.status IN (:...status)', { status: ['DELIVERY_CONFIRMED', 'DELIVERY_COMPLETE'] })
      .andWhere(
        new Brackets((qb) =>
          qb
            .where('partnerCompany.type != :galaxiaType', { galaxiaType: IPartnerCompanyType.GALAXIA })
            .orWhere('partnerCompany.type IS NULL'),
        ),
      );

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

    const orderList = await queryBuilder.getMany();

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('협력사별정산');

    // 엑셀 컬럼 정의 (모든 컬럼 텍스트 형식으로 지정하여 자동 변환 방지)
    const textStyle = { numFmt: '@' };
    sheet.columns = [
      { header: '협력사', key: 'partnerCompanyName', width: 20, style: textStyle },
      { header: '고객사', key: 'userBusinessName', width: 20, style: textStyle },
      { header: '상품번호(EP코드)', key: 'productCode', width: 15, style: textStyle },
      { header: '발송명', key: 'sendTitle', width: 25, style: textStyle },
      { header: '이벤트명', key: 'eventName', width: 25, style: textStyle },
      { header: '상품명', key: 'productName', width: 30, style: textStyle },
      { header: '브랜드명', key: 'brandName', width: 20, style: textStyle },
      { header: '금액', key: 'price', width: 12, style: textStyle },
      { header: '잔액', key: 'balance', width: 12, style: textStyle },
      { header: '유효일수', key: 'expireDay', width: 10, style: textStyle },
      { header: '유효기간시작일', key: 'validityStartAt', width: 18, style: textStyle },
      { header: '유효기간종료일', key: 'validityEndAt', width: 18, style: textStyle },
      { header: '수신번호', key: 'receiverPhone', width: 15, style: textStyle },
      { header: '발신번호', key: 'senderPhone', width: 15, style: textStyle },
      { header: '교환일자', key: 'tradeDate', width: 12, style: textStyle },
      { header: '교환시간', key: 'tradeTime', width: 10, style: textStyle },
      { header: '발송일자', key: 'sendDate', width: 12, style: textStyle },
      { header: '발송시간', key: 'sendTime', width: 10, style: textStyle },
      { header: '핀상태', key: 'pinStatus', width: 10, style: textStyle },
      { header: '핀번호', key: 'pinNumber', width: 20, style: textStyle },
      { header: '폐기시간', key: 'discardAt', width: 18, style: textStyle },
      { header: '업체거래번호', key: 'transactionId', width: 20, style: textStyle },
    ];

    // 날짜/시간 기호 없는 형식으로 변환 (엑셀용)
    const formatCompactDateTime = (date: Date | null | undefined): { date: string; time: string } => {
      if (!date) {
        return { date: '', time: '' };
      }
      return {
        date: format(date, DateCompactStr),
        time: format(date, TimeCompactStr),
      };
    };

    for (const order of orderList) {
      for (const orderProductMapping of order.orderProductMappings!) {
        const product = orderProductMapping.product;
        const partnerCompany = product.partnerCompany!;

        for (const orderDelivery of orderProductMapping.orderDeliveries!) {
          // 초이스쿠폰 선택 시 선택된 상품 정보 사용
          const displayProduct = orderDelivery.choiceSelectProduct ?? product;
          const displayPartnerCompany = orderDelivery.choiceSelectProduct?.partnerCompany ?? partnerCompany;
          const displayBrand = orderDelivery.choiceSelectProduct?.brand ?? product.brand;

          // 수신번호 복호화
          const receiverPhone = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget) ?? '';

          // 유효기간 계산 (기호 없이 yyyyMMdd 형식): 저장된 expireAt 직접 사용
          let validityStartAt = '';
          let validityEndAt = '';
          if (orderDelivery.expireAt) {
            const endDate = new Date(orderDelivery.expireAt);
            // 시작일 = 종료일 - (유효기간일수 - 1)
            const startDate = new Date(endDate.getTime() - (displayProduct.expireDay - 1) * 24 * 60 * 60 * 1000);
            validityStartAt = format(startDate, DateCompactStr);
            validityEndAt = format(endDate, DateCompactStr);
          } else if (orderDelivery.actualSendAt) {
            // fallback: expireAt 없는 레거시 데이터
            const sendDateObj = new Date(orderDelivery.actualSendAt);
            const startDate = displayPartnerCompany.validityStartsNextDay
              ? new Date(sendDateObj.getTime() + 24 * 60 * 60 * 1000)
              : sendDateObj;
            const endDate = new Date(startDate.getTime() + displayProduct.expireDay * 24 * 60 * 60 * 1000);
            validityStartAt = format(startDate, DateCompactStr);
            validityEndAt = format(endDate, DateCompactStr);
          }

          // 발송일/시간, 교환일/시간 (기호 없이 yyyyMMdd, HHmmss 형식)
          const sendDateTime = formatCompactDateTime(orderDelivery.actualSendAt);
          const tradeDateTime = formatCompactDateTime(orderDelivery.tradeAt);

          // 폐기시간 (취소/환불 시) - 상태 변경 시점인 updatedAt 사용
          let discardAt = '';
          if (
            orderDelivery.updatedAt &&
            (orderDelivery.couponStatus === 'CANCEL' || orderDelivery.couponStatus === 'REFUND_CANCEL')
          ) {
            discardAt = format(orderDelivery.updatedAt, DateFormatStr);
          }

          sheet.addRow({
            partnerCompanyName: displayPartnerCompany.businessName,
            userBusinessName: order.clientUser?.company?.businessName ?? order.user!.company?.businessName ?? '',
            productCode: displayProduct.code,
            sendTitle: orderProductMapping.sendTitle ?? '',
            eventName: order.eventName,
            productName: displayProduct.name,
            brandName: displayBrand?.nameKorean ?? '',
            price: displayProduct.price,
            balance: orderDelivery.galaxiaBalance ?? 0,
            expireDay: displayProduct.expireDay,
            validityStartAt,
            validityEndAt,
            receiverPhone,
            senderPhone: orderProductMapping.fromPhoneNumber ?? '',
            tradeDate: tradeDateTime.date,
            tradeTime: tradeDateTime.time,
            sendDate: sendDateTime.date,
            sendTime: sendDateTime.time,
            pinStatus: couponStatusToKorean(orderDelivery.couponStatus),
            pinNumber: orderDelivery.barCode ?? '',
            discardAt,
            transactionId: orderDelivery.transactionId ?? '',
          });
        }
      }
    }

    const fileName = `협력사별정산_${nowString}.xlsx`;
    const filePath = join(process.cwd(), '.', 'public', fileName);

    await workbook.xlsx.writeFile(filePath);

    const endTime = Date.now();
    const responseTime = endTime - startTime;

    // 다운로드 로그 저장
    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/settle/partner-company/excel-download',
      actionType: 'EXCEL_DOWNLOAD',
      ipAddress: '',
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime,
      downloadReason,
      recordCount: sheet.rowCount - 1, // 헤더 제외
      requestParams: { startAt, endAt, settleMethod, businessName },
    });

    return { fileName, filePath };
  }

  async getUserList(getQuery: SettleGetUserListReqQueryDto): Promise<SettleGetUserListResDto> {
    const { startAt, endAt } = this.applyDefaultDateRange(getQuery.startAt, getQuery.endAt);
    const { isPublished, businessName, personName, eventName, page, take, searchKeyword } = getQuery;

    const filters = { startAt, endAt, isPublished, businessName, personName, eventName, searchKeyword };

    const skip = (page - 1) * take;

    // 페이지 데이터 + 전체 건수를 한 번에 조회
    const [orderList, totalCount] = await this.buildUserSettleQueryBuilder(filters)
      .skip(skip)
      .take(take)
      .getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const resultList: SettleUserListViewDto[] = orderList.map((order) => {
      const billingUser = order.clientUser ?? order.user;

      const productNameList: string[] = [];
      let amount = 0;
      let finalSettlePrice = 0;

      for (const mapping of order.orderProductMappings!) {
        productNameList.push(mapping.product.name);
        amount += mapping.amount;
        finalSettlePrice += this.calculateMappingSettlePrice(mapping);
      }

      const firstDelivery = order.orderProductMappings?.[0]?.orderDeliveries?.[0];
      const sendRequestAt = firstDelivery?.actualSendAt ? format(firstDelivery.actualSendAt, DateFormatStr) : null;

      return {
        id: order.id,
        registeredAt: format(order.registerAt, DateFormatStr),
        businessName: billingUser?.company?.businessName ?? '',
        personName: billingUser?.personName ?? '',
        eventName: order.eventName,
        productNameList,
        amount,
        deliveryPrice: order.sendAmount,
        originalSettlePrice: order.settleAmount,
        settlePrice: finalSettlePrice,
        status: order.status,
        sendRequestAt,
        deliveryReportStatus: this.formatReportStatus(order.deliveryCompleteReportCount, order.deliveryReportLastSource),
        transactionStatementStatus: this.formatReportStatus(order.orderCompleteReportCount, order.transactionStatementLastSource),
        companyId: billingUser?.companyId ?? undefined,
        isCreditExcess: order.isCreditExcess ?? false,
      };
    });

    return {
      list: resultList,
      totalPage,
      totalCount,
      currentPage: page,
    };
  }

  async getUserSummary(getQuery: SettleGetUserSummaryReqQueryDto): Promise<SettleGetUserSummaryResDto> {
    const { startAt, endAt } = this.applyDefaultDateRange(getQuery.startAt, getQuery.endAt);
    const { isPublished, businessName, personName, eventName, searchKeyword } = getQuery;

    const filters = { startAt, endAt, isPublished, businessName, personName, eventName, searchKeyword };

    const sumOrders = await this.buildUserSettleQueryBuilder(filters, { forSum: true }).getMany();

    let totalAmountSum = 0;
    let totalDeliveryPriceSum = 0;
    let totalSettlePriceSum = 0;

    for (const order of sumOrders) {
      totalDeliveryPriceSum += order.sendAmount;

      for (const mapping of order.orderProductMappings!) {
        totalAmountSum += mapping.amount;
        totalSettlePriceSum += this.calculateMappingSettlePrice(mapping);
      }
    }

    return {
      totalCount: sumOrders.length,
      totalAmountSum,
      totalDeliveryPriceSum,
      totalSettlePriceSum,
    };
  }

  async getUserIds(getQuery: SettleGetUserIdsReqQueryDto): Promise<SettleGetUserIdsResDto> {
    const { startAt, endAt } = this.applyDefaultDateRange(getQuery.startAt, getQuery.endAt);
    const { isPublished, businessName, personName, eventName, searchKeyword } = getQuery;

    const filters = { startAt, endAt, isPublished, businessName, personName, eventName, searchKeyword };
    const orders = await this.buildUserSettleQueryBuilder(filters).getMany();

    if (orders.length > 1000) {
      throw new BadRequestException({
        message: '검색 결과가 1,000건을 초과합니다. 검색 범위를 좁혀주세요.',
        totalCount: orders.length,
      });
    }

    const items: SettleGetUserIdsItemDto[] = orders.map((order) => {
      const billingUser = order.clientUser ?? order.user;

      let finalSettlePrice = 0;
      for (const mapping of order.orderProductMappings!) {
        finalSettlePrice += this.calculateMappingSettlePrice(mapping);
      }

      return {
        id: order.id,
        settlePrice: finalSettlePrice,
        businessName: billingUser?.company?.businessName ?? '',
        companyId: billingUser?.companyId ?? 0,
      };
    });

    return {
      items,
      totalCount: items.length,
    };
  }

  async getUserDetail(getParam: SettleGetUserDetailReqParamDto): Promise<SettleGetUserDetailResDto> {
    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
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
        if (orderProductMapping.fee !== null && orderProductMapping.fee > 0 && orderProductMapping.priceAdjustment) {
          const originalPrice = orderProductMapping.product?.price ?? 0;
          if (orderProductMapping.priceAdjustment === IPriceAdjustment.DISCOUNT) {
            adjustedPrice = Math.ceil((originalPrice * (100 - orderProductMapping.fee)) / 100);
          } else if (orderProductMapping.priceAdjustment === IPriceAdjustment.ADDITIONAL) {
            adjustedPrice = Math.ceil((originalPrice * (100 + orderProductMapping.fee)) / 100);
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

    // 첫 번째 배송의 실제 발송 시간 사용
    const firstDelivery = order.orderProductMappings?.[0]?.orderDeliveries?.[0];
    const sendRequestAt = firstDelivery?.actualSendAt ? format(firstDelivery.actualSendAt, DateFormatStr) : null;

    // 과금 대상 사용자 (대행주문인 경우 clientUser, 아니면 user)
    const billingUser = order.clientUser ?? order.user;

    return {
      id: order.id,
      userId: order.clientUserId ?? order.userId,
      userPersonName: billingUser!.personName,
      userBusinessName: billingUser!.company?.businessName ?? '',
      operationPersonName: order.operationUser?.personName ?? null,
      eventName: order.eventName,
      type: order.type,
      sendRequestAt: sendRequestAt,
      status: order.status,
      productList: productList,
      isCreditExcess: order.isCreditExcess ?? false,
    };
  }

  async getUserDetailMultiple(getQuery: SettleGetUserDetailMultipleReqQueryDto): Promise<SettleUserDetailMultipleDto> {
    const orderIds = getQuery.ids
      .split(',')
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id));

    if (orderIds.length === 0) {
      throw new BadRequestException('유효한 주문 ID가 없습니다.');
    }

    return this.getUserDetailMultipleByOrderIds(orderIds);
  }

  async getUserDetailMultipleByBody(body: SettlePostUserDetailMultipleReqBodyDto): Promise<SettleUserDetailMultipleDto> {
    const orderIds = [...new Set(body.orderIds)];

    if (orderIds.length === 0) {
      throw new BadRequestException('유효한 주문 ID가 없습니다.');
    }

    if (orderIds.length > 1000) {
      throw new BadRequestException('최대 1,000건까지 선택할 수 있습니다.');
    }

    return this.getUserDetailMultipleByOrderIds(orderIds);
  }

  private async getUserDetailMultipleByOrderIds(orderIds: number[]): Promise<SettleUserDetailMultipleDto> {
    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .leftJoinAndSelect('order.operationUser', 'operationUser')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.id IN (:...orderIds)', { orderIds });

    const orders = await queryBuilder.getMany();

    if (orders.length === 0) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }

    // 과금 대상 사용자 (대행주문인 경우 clientUser, 아니면 user)
    const getBillingUser = (order: OrderEntity) => order.clientUser ?? order.user;

    // 고객사 검증: 동일한 고객사의 주문만 함께 조회 가능
    const billingCompanyIds = [...new Set(orders.map((order) => getBillingUser(order)!.companyId))];
    if (billingCompanyIds.length > 1) {
      throw new BadRequestException('동일한 고객사의 주문만 함께 조회할 수 있습니다.');
    }

    // 담당자 목록 수집 (중복 제거)
    const managersMap = new Map<number, { userId: number; personName: string }>();
    for (const order of orders) {
      const billingUser = getBillingUser(order);
      if (billingUser && !managersMap.has(billingUser.id)) {
        managersMap.set(billingUser.id, {
          userId: billingUser.id,
          personName: billingUser.personName,
        });
      }
    }
    const managers = Array.from(managersMap.values());

    // 이벤트명 생성: 1개면 그대로, 2개 이상이면 "첫번째 외"
    const eventNames = orders.map((order) => order.eventName);
    const eventName = eventNames.length === 1 ? eventNames[0] : `${eventNames[0]} 외`;

    // 상품 목록 통합: 동일 상품 + 동일 단가는 합산, 다른 단가는 분리
    const productMap = new Map<string, SettleProductMultipleDetailDto>();

    for (const order of orders) {
      if (order.orderProductMappings && order.orderProductMappings.length > 0) {
        for (const mapping of order.orderProductMappings) {
          // 할인/할증 적용된 단가 계산
          let adjustedPrice = mapping.product?.price ?? 0;
          if (mapping.fee !== null && mapping.fee > 0 && mapping.priceAdjustment) {
            const originalPrice = mapping.product?.price ?? 0;
            if (mapping.priceAdjustment === IPriceAdjustment.DISCOUNT) {
              adjustedPrice = Math.ceil((originalPrice * (100 - mapping.fee)) / 100);
            } else if (mapping.priceAdjustment === IPriceAdjustment.ADDITIONAL) {
              adjustedPrice = Math.ceil((originalPrice * (100 + mapping.fee)) / 100);
            }
          }

          // 키: 상품ID + 단가 (같은 상품이라도 단가가 다르면 분리)
          const key = `${mapping.product?.id}-${adjustedPrice}`;

          if (productMap.has(key)) {
            // 기존 상품에 수량 합산
            const existing = productMap.get(key)!;
            existing.amount += mapping.amount;
            // 이벤트명도 업데이트 (여러 이벤트에 걸쳐있으면 "a 외" 형태)
            if (existing.eventName !== order.eventName && !existing.eventName.endsWith(' 외')) {
              existing.eventName = `${existing.eventName} 외`;
            }
          } else {
            // 새로운 상품 추가
            productMap.set(key, {
              id: mapping.product?.id ?? 0,
              code: mapping.product?.code ?? '',
              brandName: mapping.product?.brand?.nameKorean ?? '',
              name: mapping.product?.name ?? '',
              price: adjustedPrice,
              amount: mapping.amount,
              eventName: order.eventName,
            });
          }
        }
      }
    }

    // 가장 최근 실제 발송 시각 찾기
    let latestActualSendAt: Date | null = null;
    for (const order of orders) {
      const firstDelivery = order.orderProductMappings?.[0]?.orderDeliveries?.[0];
      if (firstDelivery?.actualSendAt) {
        if (!latestActualSendAt || firstDelivery.actualSendAt > latestActualSendAt) {
          latestActualSendAt = firstDelivery.actualSendAt;
        }
      }
    }
    const sendRequestAt = latestActualSendAt ? format(latestActualSendAt, DateFormatStr) : null;

    // 첫 번째 주문 기준으로 기본 정보 설정
    const firstOrder = orders[0];
    const billingUser = getBillingUser(firstOrder);

    return {
      orderIds: orders.map((o) => o.id),
      userId: firstOrder.clientUserId ?? firstOrder.userId,
      userPersonName: billingUser!.personName,
      managers,
      userBusinessName: billingUser!.company?.businessName ?? '',
      operationPersonName: firstOrder.operationUser?.personName ?? null,
      eventName,
      type: firstOrder.type,
      sendRequestAt,
      status: firstOrder.status,
      productList: Array.from(productMap.values()),
    };
  }

  async getUserExcelDownload(user: ILoginUserInfo, getBody: SettleGetUserExcelDownloadReqDto) {
    const startTime = Date.now();

    // 비밀번호 확인
    await this.activityLogService.verifyPassword(user.id, getBody.password);

    const defaultDate = this.applyDefaultDateRange(getBody.startAt, getBody.endAt);
    const { isPublished, businessName, personName, eventName, downloadReason, searchKeyword } = getBody;
    const { startAt, endAt } = defaultDate;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
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

    if (searchKeyword) {
      queryBuilder = queryBuilder.andWhere(
        new Brackets((qb: SelectQueryBuilder<any>) => {
          qb.where('userCompany.businessName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('clientCompany.businessName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('user.personName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('clientUser.personName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('order.eventName LIKE :keyword', { keyword: `%${searchKeyword}%` });
        }),
      );
    }

    if (businessName) {
      queryBuilder = queryBuilder.andWhere(
        '(userCompany.businessName LIKE :businessName OR clientCompany.businessName LIKE :businessName)',
        { businessName: `%${businessName}%` },
      );
    }

    if (personName) {
      queryBuilder = queryBuilder.andWhere(
        '(user.personName LIKE :personName OR clientUser.personName LIKE :personName)',
        { personName: `%${personName}%` },
      );
    }

    if (eventName) {
      queryBuilder = queryBuilder.andWhere('order.eventName LIKE :eventName', {
        eventName: `%${eventName}%`,
      });
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'order', 'createdAt', startAt, endAt);
    queryBuilder = queryBuilder.orderBy('order.id', 'DESC');

    const orderList = await queryBuilder.getMany();

    const resultList = orderList.map((order) => {
      const productNameList: string[] = [];
      let amount: number = 0;

      for (const orderProductMapping of order.orderProductMappings!) {
        productNameList.push(orderProductMapping.product.name);
        amount += orderProductMapping.amount;
      }

      // 첫 번째 배송의 실제 발송 시간 사용
      const firstDelivery = order.orderProductMappings?.[0]?.orderDeliveries?.[0];
      const sendRequestAt = firstDelivery?.actualSendAt
        ? format(firstDelivery.actualSendAt, DateEndMinuteFormatStr)
        : null;

      return {
        id: order.id,
        registeredAt: format(order.registerAt, DateDateFormatStr),
        businessName: order.clientUser?.company?.businessName ?? order.user!.company?.businessName ?? '',
        personName: order.clientUser?.personName ?? order.user!.personName,
        eventName: order.eventName,
        productNameList: productNameList,
        amount: amount,
        deliveryPrice: order.sendAmount,
        settlePrice: order.settleAmount,
        originalSettlePrice: order.settleAmount,
        status: order.status,
        sendRequestAt: sendRequestAt,
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
    const { startAt, endAt, userPersonName, userBusinessName, take, page, status, dateType } = getDto;

    const dateColumn = dateType === 'ACTUAL_SEND_AT' ? 'actual_send_at' : 'created_at';

    // Phase 1: EXISTS 서브쿼리로 대상 사용자만 조회 (주문/배송 엔티티 로드 없이)
    const { clause: existsDateClause, params: existsDateParams } = this.buildDateConditions(
      'od',
      dateColumn,
      'exists',
      startAt,
      endAt,
    );

    const qb = this.userRepository
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.company', 'uc')
      .where(
        `EXISTS (
          SELECT 1 FROM \`order\` o
          INNER JOIN order_product_mapping opm ON opm.order_id = o.id
          INNER JOIN order_delivery od ON od.order_product_mapping_id = opm.id
          WHERE (o.client_user_id = u.id OR (o.client_user_id IS NULL AND o.user_id = u.id))${existsDateClause}
        )`,
        existsDateParams,
      )
      .orderBy('u.id', 'DESC');

    if (userPersonName) {
      qb.andWhere('u.personName LIKE :userPersonName', { userPersonName: `%${userPersonName}%` });
    }
    if (userBusinessName) {
      qb.andWhere('uc.businessName LIKE :userBusinessName', { userBusinessName: `%${userBusinessName}%` });
    }

    const allUsers = await qb.getMany();

    // Phase 2: 동일 회사별 allSettleAmount 합산
    const companyAllSettleMap = new Map<number, number>();
    for (const user of allUsers) {
      if (!user.companyId) continue;
      const current = companyAllSettleMap.get(user.companyId) ?? 0;
      companyAllSettleMap.set(user.companyId, current + user.allSettleAmount);
    }

    // Phase 3: remainServiceAmount 계산 및 결과 생성
    const allResults: SettleUserPerListViewDto[] = allUsers.map((user) => {
      const companyMaximumLimit = Number(user.company?.maximumLimit ?? 0);

      const effectiveBalance =
        user.company?.balanceManagementType === 'COMPANY' ? user.company.balance : user.balance;

      const companyTotal = user.companyId ? companyAllSettleMap.get(user.companyId) : undefined;
      const remainServiceAmount =
        companyTotal !== undefined
          ? companyMaximumLimit + effectiveBalance - companyTotal
          : effectiveBalance - user.allSettleAmount;

      return {
        id: user.id,
        email: user.email,
        businessName: user.company?.businessName ?? '',
        personName: user.personName,
        settleCondition: user.settleCondition,
        settlePeriodCondition: user.settlePeriodCondition,
        settlePeriodCount: user.settlePeriodCount,
        maximumLimit: companyMaximumLimit,
        serviceAmount: user.allSettleAmount,
        overdueCount: 0,
        overdueAmount: 0,
        balance: effectiveBalance,
        remainServiceAmount,
        status: remainServiceAmount > 0 ? SettleUserStatusEnum.ACTIVE : SettleUserStatusEnum.STOP,
      };
    });

    // Phase 4: 상태 필터링 및 페이지네이션
    let filtered: SettleUserPerListViewDto[];
    if (status === 'ACTIVE') {
      filtered = allResults.filter((r) => r.remainServiceAmount > 0);
    } else if (status === 'STOP') {
      filtered = allResults.filter((r) => r.remainServiceAmount <= 0);
    } else {
      filtered = allResults;
    }

    const totalCount = filtered.length;
    const skip = (page - 1) * take;
    const pageResult = filtered.slice(skip, skip + take);

    // Phase 5: 현재 페이지 사용자에 대해서만 overdue 통계 조회
    if (pageResult.length > 0) {
      const pageUserIds = pageResult.map((r) => r.id);

      const { clause: overdueDateClause, params: overdueDateParams } = this.buildDateConditions(
        'od2',
        dateColumn,
        'overdue',
        startAt,
        endAt,
      );

      const overdueQb = this.orderRepository
        .createQueryBuilder('o')
        .select('o.id', 'orderId')
        .addSelect('o.userId', 'userId')
        .addSelect('o.clientUserId', 'clientUserId')
        .addSelect('o.sendAmount', 'sendAmount')
        .where(
          new Brackets((wb) => {
            wb.where('o.clientUserId IN (:...pageUserIds)', { pageUserIds }).orWhere(
              new Brackets((wb2) => {
                wb2.where('o.clientUserId IS NULL').andWhere('o.userId IN (:...pageUserIds2)', { pageUserIds2: pageUserIds });
              }),
            );
          }),
        )
        .andWhere('o.status = :overdueStatus', { overdueStatus: 'DELIVERY_COMPLETE' })
        .andWhere('o.settleStatus = :overdueSettleStatus', {
          overdueSettleStatus: 'UNSETTLE_OVERDUE',
        })
        .andWhere(
          `EXISTS (
            SELECT 1 FROM order_product_mapping opm2
            INNER JOIN order_delivery od2 ON od2.order_product_mapping_id = opm2.id
            WHERE opm2.order_id = o.id${overdueDateClause}
          )`,
          overdueDateParams,
        );

      const overdueOrders = await overdueQb.getRawMany();

      const pageUserIdSet = new Set(pageUserIds);
      const userOverdueMap = new Map<number, { count: number; amount: number }>();

      for (const row of overdueOrders) {
        const userId = Number(row.userId);
        const clientUserId = row.clientUserId ? Number(row.clientUserId) : null;
        const sendAmount = Number(row.sendAmount);

        // 과금 대상에게만 연체 누적 (대행주문이면 clientUserId, 아니면 userId)
        const billingUserId = clientUserId ?? userId;
        if (pageUserIdSet.has(billingUserId)) {
          this.accumulateOverdue(userOverdueMap, billingUserId, sendAmount);
        }
      }

      for (const item of pageResult) {
        const overdue = userOverdueMap.get(item.id);
        if (overdue) {
          item.overdueCount = overdue.count;
          item.overdueAmount = overdue.amount;
        }
      }
    }

    return {
      list: pageResult,
      totalCount,
      totalPage: Math.ceil(totalCount / take),
      currentPage: page,
    };
  }

  private buildDateConditions(
    alias: string,
    dateColumn: string,
    prefix: string,
    startAt?: string,
    endAt?: string,
  ): { clause: string; params: Record<string, any> } {
    const conditions: string[] = [];
    const params: Record<string, any> = {};

    if (startAt) {
      const paramName = `${prefix}StartAt`;
      conditions.push(`${alias}.${dateColumn} >= :${paramName}`);
      params[paramName] = new Date(startAt);
    }
    if (endAt) {
      const paramName = `${prefix}EndAt`;
      conditions.push(`${alias}.${dateColumn} <= :${paramName}`);
      params[paramName] = new Date(endAt);
    }

    const clause = conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '';
    return { clause, params };
  }

  private accumulateOverdue(
    map: Map<number, { count: number; amount: number }>,
    userId: number,
    amount: number,
  ): void {
    const entry = map.get(userId) ?? { count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += amount;
    map.set(userId, entry);
  }

  async getUserPerDetail(getDto: SettleGetUserPerDetailReqQueryDto): Promise<SettleGetPerUserDetailResDto> {
    const { userId, startAt, endAt, userBusinessName, userPersonName, settleStatus, take, page } = getDto;

    // 대행주문은 과금대상(clientUserId)의 정산에만 귀속
    const billingUserCondition = '(order.clientUserId = :userId OR (order.clientUserId IS NULL AND order.userId = :userId))';

    const applyFilters = (qb: SelectQueryBuilder<OrderEntity>) => {
      qb.where(billingUserCondition, { userId })
        .andWhere('order.status IN (:...status)', { status: ['DELIVERY_CONFIRMED', 'DELIVERY_COMPLETE'] });

      QueryBuilderDateCondition(qb, 'orderProductMappings', 'sendRequestAt', startAt, endAt);

      if (userBusinessName) {
        qb.andWhere(
          '(userCompany.businessName LIKE :userBusinessName OR clientCompany.businessName LIKE :userBusinessName)',
          { userBusinessName: `%${userBusinessName}%` },
        );
      }
      if (userPersonName) {
        qb.andWhere(
          '(user.personName LIKE :userPersonName OR clientUser.personName LIKE :userPersonName)',
          { userPersonName: `%${userPersonName}%` },
        );
      }

      if (settleStatus) {
        if (settleStatus === 'UNSETTLE_NORMAL') {
          qb.andWhere(
            new Brackets((wb) => {
              wb.where('order.settleStatus = :settleStatus', { settleStatus }).orWhere(
                'order.settleStatus IS NULL',
              );
            }),
          );
        } else {
          qb.andWhere('order.settleStatus = :settleStatus', { settleStatus });
        }
      }
    };

    // 카운트 쿼리 (최소한의 JOIN)
    const countQb = this.orderRepository
      .createQueryBuilder('order')
      .innerJoin('order.user', 'user')
      .leftJoin('user.company', 'userCompany')
      .leftJoin('order.clientUser', 'clientUser')
      .leftJoin('clientUser.company', 'clientCompany')
      .innerJoin('order.orderProductMappings', 'orderProductMappings');

    applyFilters(countQb);
    const totalCount = await countQb.getCount();

    // 데이터 쿼리 (orderDeliveries JOIN 제거 — actualSendAt은 별도 조회)
    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientCompany')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product');

    applyFilters(queryBuilder);
    queryBuilder.orderBy('order.id', 'DESC');
    queryBuilder.skip((page - 1) * take).take(take);

    const orderList = await queryBuilder.getMany();

    const orderIds = orderList.length > 0 ? orderList.map((o) => o.id) : [];

    // actualSendAt 별도 조회 (주문별 첫 번째 배송건의 actualSendAt)
    const actualSendAtMap = new Map<number, Date | null>();
    if (orderIds.length > 0) {
      const sendDates = await this.orderDeliveryRepository
        .createQueryBuilder('od')
        .select('opm.orderId', 'orderId')
        .addSelect('MIN(od.actualSendAt)', 'actualSendAt')
        .innerJoin('od.orderProductMapping', 'opm')
        .where('opm.orderId IN (:...orderIds)', { orderIds })
        .groupBy('opm.orderId')
        .getRawMany();

      for (const row of sendDates) {
        actualSendAtMap.set(Number(row.orderId), row.actualSendAt ? new Date(row.actualSendAt) : null);
      }
    }

    // 폐기 복구 금액 조회 (DISCARD_RESTORE ActivityLog에서 orderId별 합산)
    const discardRestoreMap = new Map<number, number>();
    if (orderIds.length > 0) {
      const restoreLogs = await this.activityLogRepository
        .createQueryBuilder('al')
        .select("JSON_EXTRACT(al.requestParams, '$.orderId')", 'orderId')
        .addSelect("SUM(JSON_EXTRACT(al.requestParams, '$.restoreAmount'))", 'totalRestore')
        .where('al.actionType = :actionType', { actionType: ActivityLogActionType.DISCARD_RESTORE })
        .andWhere("JSON_EXTRACT(al.requestParams, '$.orderId') IN (:...orderIds)", { orderIds })
        .andWhere('al.deletedAt IS NULL')
        .groupBy("JSON_EXTRACT(al.requestParams, '$.orderId')")
        .getRawMany();

      for (const row of restoreLogs) {
        discardRestoreMap.set(Number(row.orderId), Number(row.totalRestore) || 0);
      }
    }

    const resultList: SettleUserPerDetailViewDto[] = orderList.map((order) => {
      const mappings = order.orderProductMappings;
      let productName = '';
      if (mappings && mappings.length > 0) {
        productName = mappings[0].product.name;
        if (mappings.length > 1) {
          productName += `외 ${mappings.length - 1}건`;
        }
      }

      const actualSendAt = actualSendAtMap.get(order.id);
      const sendRequestAt = actualSendAt ? format(actualSendAt, DateFormatStr) : null;

      return {
        id: order.id,
        userBusinessName: order.clientUser?.company?.businessName ?? order.user!.company?.businessName ?? '',
        userPersonName: order.clientUser?.personName ?? order.user!.personName,
        sendRequestAt,
        eventName: order.eventName,
        productName,
        settleAmount: order.sendAmount,
        settleDiscountAmount: order.settleAmount,
        isOrderCompleteReport: order.orderCompleteReportCount > 0,
        settleStatus: order.settleStatus,
        isSettleComplete: order.isSettleComplete,
        discardRestoreAmount: discardRestoreMap.get(order.id) ?? null,
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

    // 과금 대상 사용자 조회 (대행주문인 경우 clientUserId)
    const billingUserId = order.clientUserId ?? order.userId;
    const user = await this.userRepository.findOne({
      where: {
        id: billingUserId,
      },
    });

    if (!user) {
      throw new InternalServerErrorException('과금 대상 유저가 존재하지 않습니다.');
    }

    // 선정산(PRE_PAYMENT): 토글 허용, 금액 로직 스킵
    if (user.settleCondition === IUserSettleCondition.PRE_PAYMENT) {
      const allowedForPrePayment = [
        SettleUserOrderDetailEnum.SETTLE_COMPLETE,
        SettleUserOrderDetailEnum.UNSETTLE_NORMAL,
      ];
      if (!allowedForPrePayment.includes(settleStatus)) {
        throw new BadRequestException('선정산 주문에 허용되지 않는 정산 상태입니다.');
      }
      order.settleStatus = settleStatus;
      await this.orderRepository.save(order);
      return;
    }

    // 후정산(POST_PAYMENT): 기존 로직 그대로
    if (order.settleStatus === SettleUserOrderDetailEnum.SETTLE_COMPLETE) {
      throw new BadRequestException('이미 정산이 완료된 주문입니다.');
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

  async batchConfirmUserPerOrders(orderIds: number[]) {
    const success: number[] = [];
    const failed: { orderId: number; reason: string }[] = [];
    const skipped: number[] = [];

    // 주문 일괄 조회
    const orders = await this.orderRepository.find({
      where: { id: In(orderIds) },
    });
    const orderMap = new Map(orders.map((o) => [o.id, o]));

    // 존재하지 않는 주문 처리
    for (const id of orderIds) {
      if (!orderMap.has(id)) {
        failed.push({ orderId: id, reason: '주문이 존재하지 않습니다.' });
      }
    }

    // billing user 일괄 조회 (N+1 방지)
    const billingUserIds = [...new Set(
      orders
        .filter((o) => o.settleStatus !== SettleUserOrderDetailEnum.SETTLE_COMPLETE)
        .map((o) => o.clientUserId ?? o.userId),
    )];
    const users = billingUserIds.length > 0
      ? await this.userRepository.find({ where: { id: In(billingUserIds) } })
      : [];
    const userMap = new Map<number, UserEntity>(users.map((u) => [u.id, u]));

    for (const order of orders) {
      try {
        // 이미 정산완료인 건은 스킵
        if (order.settleStatus === SettleUserOrderDetailEnum.SETTLE_COMPLETE) {
          skipped.push(order.id);
          continue;
        }

        // 과금 대상 사용자 결정
        const billingUserId = order.clientUserId ?? order.userId;
        const user = userMap.get(billingUserId);

        if (!user) {
          failed.push({ orderId: order.id, reason: '과금 대상 유저가 존재하지 않습니다.' });
          continue;
        }

        // 선정산(PRE_PAYMENT): settleStatus만 변경
        if (user.settleCondition === IUserSettleCondition.PRE_PAYMENT) {
          order.settleStatus = SettleUserOrderDetailEnum.SETTLE_COMPLETE;
          await this.orderRepository.save(order);
          success.push(order.id);
          continue;
        }

        // 후정산(POST_PAYMENT): settleStatus + isSettleComplete + allSettleAmount 차감
        order.settleStatus = SettleUserOrderDetailEnum.SETTLE_COMPLETE;
        order.isSettleComplete = true;
        await this.orderRepository.save(order);
        user.allSettleAmount -= order.settleAmount;
        success.push(order.id);
      } catch (e) {
        failed.push({ orderId: order.id, reason: e.message || '처리 중 오류가 발생했습니다.' });
      }
    }

    // 변경된 user 일괄 저장 (allSettleAmount 누적 차감 반영)
    for (const user of userMap.values()) {
      try {
        await this.userRepository.save(user);
      } catch (e) {
        console.error(`[batchConfirmUserPerOrders] user save 실패 (userId: ${user.id}):`, e.message);
      }
    }

    return { success, failed, skipped };
  }

  @Transactional()
  async syncSettleOverdue() {
    // 1. 정산기일 설정이 있는 사용자 목록 조회
    const userList = await this.userRepository.find({
      where: {
        settlePeriodCount: Not(IsNull()),
        settlePeriodCondition: Not(IsNull()),
      },
    });

    if (userList.length === 0) return;

    const userIds = userList.map((u) => u.id);
    const userMap = new Map(userList.map((u) => [u.id, u]));

    // 2. 해당 사용자들의 미정산 주문을 단일 쿼리로 조회 (N+1 방지)
    // UNSETTLE_OVERDUE도 포함하여 리셋 대상 판별
    // 대행주문 포함: clientUserId 또는 (clientUserId가 없는 경우) userId 기준
    const allOrders = await this.orderRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .leftJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where(
        new Brackets((wb) => {
          wb.where('order.clientUserId IN (:...userIds)', { userIds }).orWhere(
            new Brackets((wb2) => {
              wb2.where('order.clientUserId IS NULL').andWhere('order.userId IN (:...userIds2)', { userIds2: userIds });
            }),
          );
        }),
      )
      .andWhere(
        new Brackets((qb) => {
          qb.where('order.settleStatus IS NULL')
            .orWhere('order.settleStatus = :settleNormal', {
              settleNormal: SettleUserOrderDetailEnum.UNSETTLE_NORMAL,
            })
            .orWhere('order.settleStatus = :settleOverdue', {
              settleOverdue: SettleUserOrderDetailEnum.UNSETTLE_OVERDUE,
            });
        }),
      )
      .andWhere('order.status = :status', { status: 'DELIVERY_COMPLETE' })
      .getMany();

    // 3. 과금 대상 userId별로 주문 그룹핑 (대행주문이면 clientUserId)
    const ordersByUserId = new Map<number, typeof allOrders>();
    for (const order of allOrders) {
      const billingUserId = order.clientUserId ?? order.userId;
      if (!ordersByUserId.has(billingUserId)) {
        ordersByUserId.set(billingUserId, []);
      }
      ordersByUserId.get(billingUserId)!.push(order);
    }

    // 4. 사용자별 정산기일 초과 주문 판별 (actualSendAt 기준)
    const now = new Date();
    const overdueOrderIds: number[] = [];
    const resetOrderIds: number[] = [];

    for (const [userId, orderList] of ordersByUserId) {
      const user = userMap.get(userId);
      if (!user) continue;

      const condition = user.settlePeriodCondition!;
      const count = user.settlePeriodCount!;

      let monthOffset: number;
      switch (condition) {
        case UserSettlePeriodConditionEnum.CURRENT_MONTH:
          monthOffset = 0;
          break;
        case UserSettlePeriodConditionEnum.NEXT_MONTH:
          monthOffset = 1;
          break;
        case UserSettlePeriodConditionEnum.NEXT_MONTH_AFTER:
          monthOffset = 2;
          break;
        default:
          monthOffset = 0;
          break;
      }

      for (const order of orderList) {
        // actualSendAt 확보: orderDeliveries 중 가장 빠른 실제발송일
        const deliveryDates = (order.orderProductMappings ?? [])
          .flatMap((m) => m.orderDeliveries ?? [])
          .map((d) => d.actualSendAt)
          .filter((d): d is Date => d != null);

        const actualSendAt = deliveryDates.length > 0
          ? new Date(Math.min(...deliveryDates.map((d) => d.getTime())))
          : null;

        if (!actualSendAt) continue;

        let deadline: Date;
        if (condition === UserSettlePeriodConditionEnum.DELIVERY_DATE) {
          deadline = new Date(
            actualSendAt.getFullYear(),
            actualSendAt.getMonth(),
            actualSendAt.getDate() + count,
          );
        } else {
          deadline = new Date(
            actualSendAt.getFullYear(),
            actualSendAt.getMonth() + monthOffset,
            count,
          );
        }

        const isOverdue = now >= deadline;

        if (isOverdue && order.settleStatus !== SettleUserOrderDetailEnum.UNSETTLE_OVERDUE) {
          overdueOrderIds.push(order.id);
        } else if (!isOverdue && order.settleStatus === SettleUserOrderDetailEnum.UNSETTLE_OVERDUE) {
          resetOrderIds.push(order.id);
        }
      }
    }

    // 5. 초과 주문 일괄 업데이트
    if (overdueOrderIds.length > 0) {
      await this.orderRepository.update(overdueOrderIds, {
        settleStatus: SettleUserOrderDetailEnum.UNSETTLE_OVERDUE,
      });
    }

    // 6. 잘못 마킹된 주문 리셋 (마감일 전인데 OVERDUE인 주문 → NORMAL로)
    if (resetOrderIds.length > 0) {
      await this.orderRepository.update(resetOrderIds, {
        settleStatus: SettleUserOrderDetailEnum.UNSETTLE_NORMAL,
      });
    }
  }

  /**
   * 로그인한 사용자의 잔여 발송 한도 조회
   * - 잔여서비스한도 = 회사최대한도 + effectiveBalance - 회사전체allSettleAmount
   * - effectiveBalance: balanceManagementType이 COMPANY이면 company.balance, 아니면 user.balance
   * - 동일 회사의 모든 계정이 한도를 공유함
   * @param user 로그인한 사용자 정보
   * @returns 잔여 발송 한도 정보
   */
  async getRemainServiceAmount(user: ILoginUserInfo): Promise<SettleGetRemainServiceAmountResDto> {
    // 사용자 정보 조회
    const userEntity = await this.userRepository.findOne({
      where: { id: user.id },
      relations: ['orders', 'company'],
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

    const companyMaximumLimit = userEntity.company?.maximumLimit ?? 0;

    // 동일 회사의 모든 계정 allSettleAmount 합산
    let totalAllSettleAmount = userEntity.allSettleAmount;
    if (userEntity.companyId) {
      const companyUsers = await this.userRepository.find({
        where: { companyId: userEntity.companyId },
        select: ['id', 'allSettleAmount'],
      });
      totalAllSettleAmount = companyUsers.reduce((sum, u) => sum + u.allSettleAmount, 0);
    }

    // balanceManagementType에 따른 실제 balance 결정
    const effectiveBalance = userEntity.company?.balanceManagementType === 'COMPANY'
      ? userEntity.company.balance
      : userEntity.balance;

    // 잔여발송한도 = 회사최대한도 + effectiveBalance - 회사전체allSettleAmount
    const remainServiceAmount = companyMaximumLimit + effectiveBalance - totalAllSettleAmount;

    return {
      maximumLimit: companyMaximumLimit,
      balance: effectiveBalance,
      serviceAmount: userEntity.serviceAmount,
      overdueAmount,
      allSettleAmount: userEntity.allSettleAmount,
      remainServiceAmount,
      creditExcessAmount: remainServiceAmount < 0 ? Math.abs(remainServiceAmount) : 0,
    };
  }

  /**
   * 리포트 발행 상태 문자열 생성
   * count=0이면 '-', 1이면 '발행 완료'/'다운로드 완료', 2이상이면 '발행(재)'/'다운로드(재)'
   */
  private formatReportStatus(count: number, lastSource: string | null): string {
    if (count === 0) {
      return '-';
    }
    const isReissue = count > 1;
    if (lastSource === 'DIRECT') {
      return isReissue ? '발행(재)' : '발행 완료';
    }
    return isReissue ? '다운로드(재)' : '다운로드 완료';
  }

  /**
   * orderProductMapping에 저장된 fee/priceAdjustment를 적용하여 해당 매핑의 정산금액을 계산한다.
   * 정산 리스트는 완료건(DELIVERY_CONFIRMED/DELIVERY_COMPLETE)만 조회하므로
   * 현재 UserDiscount로 폴백하지 않고 매핑에 저장된 값만 사용한다.
   * (새로 등록된 할인조건이 이미 완료된 주문에 소급 적용되는 것을 방지)
   */
  private calculateMappingSettlePrice(
    mapping: { fee: number | null; priceAdjustment: IPriceAdjustment | null; amount: number; product: { price: number; category: string; brand?: { nameKorean: string } | null }; orderDeliveries?: { settleFee: number | null; settlePriceAdjustment: string | null }[] },
  ): number {
    // SSG 중복할인: delivery에 settleFee가 있으면 delivery별로 계산 후 합산
    const deliveries = mapping.orderDeliveries ?? [];
    const hasDeliveryFee = deliveries.some((d) => d.settleFee !== null);

    if (hasDeliveryFee) {
      let total = 0;
      for (const delivery of deliveries) {
        const fee = delivery.settleFee ?? mapping.fee;
        const priceAdjustment = delivery.settlePriceAdjustment ?? mapping.priceAdjustment;
        let price = mapping.product.price;
        if (fee !== null && fee > 0 && priceAdjustment !== null) {
          if (priceAdjustment === IPriceAdjustment.DISCOUNT) {
            price = Math.ceil((mapping.product.price * (100 - fee)) / 100);
          } else if (priceAdjustment === IPriceAdjustment.ADDITIONAL) {
            price = Math.ceil((mapping.product.price * (100 + fee)) / 100);
          }
        }
        total += price;
      }
      return total;
    }

    // 기존 로직: 매핑 레벨 fee 사용
    const productTotalPrice = mapping.product.price * mapping.amount;

    if (mapping.fee !== null && mapping.priceAdjustment !== null) {
      let adjustedPrice = productTotalPrice;
      if (mapping.fee > 0) {
        if (mapping.priceAdjustment === IPriceAdjustment.DISCOUNT) {
          adjustedPrice = Math.ceil((productTotalPrice * (100 - mapping.fee)) / 100);
        } else if (mapping.priceAdjustment === IPriceAdjustment.ADDITIONAL) {
          adjustedPrice = Math.ceil((productTotalPrice * (100 + mapping.fee)) / 100);
        }
      }
      return adjustedPrice;
    }

    // 매핑에 할인 정보가 없으면 정가 반환
    return productTotalPrice;
  }

  /**
   * getUserList / getUserIds 공통 쿼리빌더 생성
   * 동일한 join + 필터 조건을 공유한다.
   *
   * forSum=true: 합산 계산 전용 경량 쿼리 (display 전용 JOIN 제외)
   *  - company: leftJoin만 (SELECT 제외, 필터용)
   *  - classification: 제외
   *  - orderDeliveries: innerJoin만 (SELECT 제외, 필터용)
   *  - orderBy: 제외
   */
  private buildUserSettleQueryBuilder(
    filters: {
      startAt?: string;
      endAt?: string;
      isPublished?: boolean;
      businessName?: string;
      personName?: string;
      eventName?: string;
      searchKeyword?: string;
    },
    options?: { forSum?: boolean },
  ) {
    const forSum = options?.forSum ?? false;
    const { startAt, endAt, isPublished, businessName, personName, eventName, searchKeyword } = filters;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user');

    // forSum: company는 필터용 JOIN만, classification/orderDeliveries는 SELECT 제외
    if (forSum) {
      queryBuilder = queryBuilder
        .leftJoin('user.company', 'userCompany')
        .leftJoinAndSelect('order.clientUser', 'clientUser')
        .leftJoin('clientUser.company', 'clientCompany');
    } else {
      queryBuilder = queryBuilder
        .leftJoinAndSelect('user.company', 'userCompany')
        .leftJoinAndSelect('order.clientUser', 'clientUser')
        .leftJoinAndSelect('clientUser.company', 'clientCompany');
    }

    queryBuilder = queryBuilder
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product');

    if (!forSum) {
      queryBuilder = queryBuilder.leftJoinAndSelect('product.classification', 'classification');
    }

    queryBuilder = queryBuilder.leftJoinAndSelect('product.brand', 'brand');

    // forSum: orderDeliveries JOIN 제거 — status 필터로 이미 확정된 주문만 조회되므로 불필요
    // 이 JOIN이 매핑당 배송건수만큼 행을 증폭시켜 성능 저하의 주원인이었음
    if (!forSum) {
      queryBuilder = queryBuilder.innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries');
    }

    queryBuilder = queryBuilder
      .where('order.status IN (:...status)', { status: ['DELIVERY_CONFIRMED', 'DELIVERY_COMPLETE'] });

    if (isPublished === true) {
      queryBuilder = queryBuilder
        .andWhere('order.deliveryCompleteReportCount > 0')
        .andWhere('order.orderCompleteReportCount > 0');
    }

    if (isPublished === false) {
      queryBuilder = queryBuilder
        .andWhere('order.deliveryCompleteReportCount = 0')
        .andWhere('order.orderCompleteReportCount = 0');
    }

    // 통합 검색 (searchKeyword) 처리
    if (searchKeyword) {
      queryBuilder = queryBuilder.andWhere(
        new Brackets((qb: SelectQueryBuilder<any>) => {
          qb.where('userCompany.businessName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('clientCompany.businessName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('user.personName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('clientUser.personName LIKE :keyword', { keyword: `%${searchKeyword}%` })
            .orWhere('order.eventName LIKE :keyword', { keyword: `%${searchKeyword}%` });
        }),
      );
    }

    if (businessName) {
      queryBuilder = queryBuilder.andWhere(
        '(userCompany.businessName LIKE :businessName OR clientCompany.businessName LIKE :businessName)',
        { businessName: `%${businessName}%` },
      );
    }

    if (personName) {
      queryBuilder = queryBuilder.andWhere(
        '(user.personName LIKE :personName OR clientUser.personName LIKE :personName)',
        { personName: `%${personName}%` },
      );
    }

    if (eventName) {
      queryBuilder = queryBuilder.andWhere('order.eventName LIKE :eventName', {
        eventName: `%${eventName}%`,
      });
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'order', 'createdAt', startAt, endAt);

    if (!forSum) {
      queryBuilder = queryBuilder.orderBy('order.id', 'DESC');
    }

    return queryBuilder;
  }

  // findMatchingDiscount는 user_discount/domain/discount.matcher.ts 공통 함수 사용

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

  private getAppDivName(appDiv: string): string {
    switch (appDiv) {
      case '10':
        return '사용';
      case '20':
        return '사용취소';
      case '25':
        return '망취소';
      case '81':
        return '환불등록';
      default:
        return appDiv;
    }
  }

  async getGalaxiaList(getQuery: SettleGetGalaxiaListReqQueryDto): Promise<SettleGetGalaxiaListResDto> {
    const defaultDate = this.applyDefaultDateRange(getQuery.startAt, getQuery.endAt);
    const { businessName, appDiv, page, take } = getQuery;
    const { startAt, endAt } = defaultDate;

    let queryBuilder = this.galaxiaBarcodeLogRepository
      .createQueryBuilder('log')
      .innerJoinAndSelect('log.orderDelivery', 'orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.partnerCompany', 'choicePartnerCompany');

    // appDay 기준 날짜 필터링 (yyyy-MM-ddTHH:mm:ss → YYYYMMDD 변환)
    if (startAt) {
      const startDay = startAt.replace(/[-T:]/g, '').substring(0, 8);
      queryBuilder = queryBuilder.andWhere('log.appDay >= :startDay', { startDay });
    }
    if (endAt) {
      const endDay = endAt.replace(/[-T:]/g, '').substring(0, 8);
      queryBuilder = queryBuilder.andWhere('log.appDay <= :endDay', { endDay });
    }

    if (businessName) {
      queryBuilder = queryBuilder.andWhere('userCompany.businessName LIKE :businessName', {
        businessName: `%${businessName}%`,
      });
    }

    if (appDiv) {
      queryBuilder = queryBuilder.andWhere('log.appDiv = :appDiv', { appDiv });
    }

    const totalCount = await queryBuilder.getCount();
    const totalPage = Math.ceil(totalCount / take);

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.orderBy('log.appDay', 'DESC').addOrderBy('log.appTime', 'DESC').skip(skip).take(take);

    const logList = await queryBuilder.getMany();

    const resultList: SettleGalaxiaListViewDto[] = logList.map((log) => {
      const orderDelivery = log.orderDelivery;
      const orderProductMapping = orderDelivery.orderProductMapping;
      const order = orderProductMapping.order;
      const product = orderProductMapping.product;
      const displayProduct = orderDelivery.choiceSelectProduct ?? product;

      return {
        id: log.id,
        orderDeliveryId: log.orderDeliveryId,
        barcode: log.barcode,
        appDiv: log.appDiv,
        appDivName: this.getAppDivName(log.appDiv),
        appDay: log.appDay,
        appTime: log.appTime,
        amount: log.amount,
        appNo: log.appNo,
        appStore: log.appStore ?? '',
        giftKind: log.giftKind,
        productName: displayProduct.name,
        productPrice: displayProduct.price,
        galaxiaBalance: orderDelivery.galaxiaBalance ?? 0,
        userBusinessName: order.user?.company?.businessName ?? '',
        eventName: order.eventName,
        code: displayProduct.code,
        partnerCompanyName: displayProduct.partnerCompany?.businessName ?? '',
      };
    });

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  async galaxiaExcelDownload(user: ILoginUserInfo, body: SettleGalaxiaExcelDownloadReqDto) {
    const startTime = Date.now();

    await this.activityLogService.verifyPassword(user.id, body.password);

    const defaultDate = this.applyDefaultDateRange(body.startAt, body.endAt);
    const { businessName, appDiv, downloadReason } = body;
    const { startAt, endAt } = defaultDate;

    const now = new Date();
    const nowString = format(now, 'yyyyMMdd');

    let queryBuilder = this.galaxiaBarcodeLogRepository
      .createQueryBuilder('log')
      .innerJoinAndSelect('log.orderDelivery', 'orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('orderDelivery.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.partnerCompany', 'choicePartnerCompany');

    if (startAt) {
      const startDay = startAt.replace(/[-T:]/g, '').substring(0, 8);
      queryBuilder = queryBuilder.andWhere('log.appDay >= :startDay', { startDay });
    }
    if (endAt) {
      const endDay = endAt.replace(/[-T:]/g, '').substring(0, 8);
      queryBuilder = queryBuilder.andWhere('log.appDay <= :endDay', { endDay });
    }

    if (businessName) {
      queryBuilder = queryBuilder.andWhere('userCompany.businessName LIKE :businessName', {
        businessName: `%${businessName}%`,
      });
    }

    if (appDiv) {
      queryBuilder = queryBuilder.andWhere('log.appDiv = :appDiv', { appDiv });
    }

    queryBuilder = queryBuilder.orderBy('log.appDay', 'DESC').addOrderBy('log.appTime', 'DESC');

    const logList = await queryBuilder.getMany();

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('갤럭시아정산');

    const textStyle = { numFmt: '@' };
    sheet.columns = [
      { header: '고객사', key: 'userBusinessName', width: 20, style: textStyle },
      { header: '이벤트명', key: 'eventName', width: 25, style: textStyle },
      { header: 'EP코드', key: 'code', width: 15, style: textStyle },
      { header: '협력사', key: 'partnerCompanyName', width: 20, style: textStyle },
      { header: '상품명', key: 'productName', width: 30, style: textStyle },
      { header: '상품 정상가', key: 'productPrice', width: 12, style: textStyle },
      { header: '바코드', key: 'barcode', width: 25, style: textStyle },
      { header: '업체거래번호', key: 'transactionId', width: 25, style: textStyle },
      { header: '거래구분', key: 'appDivName', width: 12, style: textStyle },
      { header: '발송일자', key: 'sendDate', width: 12, style: textStyle },
      { header: '발송시간', key: 'sendTime', width: 10, style: textStyle },
      { header: '사용일자', key: 'appDay', width: 12, style: textStyle },
      { header: '사용시간', key: 'appTime', width: 10, style: textStyle },
      { header: '사용금액', key: 'amount', width: 12, style: textStyle },
      { header: '승인번호', key: 'appNo', width: 15, style: textStyle },
      { header: '사용처', key: 'appStore', width: 20, style: textStyle },
      { header: '상품권종류', key: 'giftKind', width: 12, style: textStyle },
      { header: '현재잔액', key: 'galaxiaBalance', width: 12, style: textStyle },
      { header: '정산대상금액', key: 'settlementTargetAmount', width: 15, style: textStyle },
    ];

    for (const log of logList) {
      const orderDelivery = log.orderDelivery;
      const orderProductMapping = orderDelivery.orderProductMapping;
      const order = orderProductMapping.order;
      const product = orderProductMapping.product;
      const displayProduct = orderDelivery.choiceSelectProduct ?? product;

      sheet.addRow({
        userBusinessName: order.user?.company?.businessName ?? '',
        eventName: order.eventName,
        code: displayProduct.code,
        partnerCompanyName: displayProduct.partnerCompany?.businessName ?? '',
        productName: displayProduct.name,
        productPrice: displayProduct.price,
        barcode: log.barcode,
        transactionId: orderDelivery.transactionId ?? '',
        appDivName: this.getAppDivName(log.appDiv),
        sendDate: orderDelivery.actualSendAt
          ? format(orderDelivery.actualSendAt, DateCompactStr)
          : '',
        sendTime: orderDelivery.actualSendAt
          ? format(orderDelivery.actualSendAt, TimeCompactStr)
          : '',
        appDay: log.appDay,
        appTime: log.appTime,
        amount: log.amount,
        appNo: log.appNo,
        appStore: log.appStore ?? '',
        giftKind: log.giftKind,
        galaxiaBalance: orderDelivery.galaxiaBalance ?? 0,
        settlementTargetAmount: this.getGalaxiaSettlementTargetAmount(
          displayProduct.settleMethod,
          log.amount,
          displayProduct.price,
        ),
      });
    }

    const fileName = `갤럭시아정산_${nowString}.xlsx`;
    const filePath = join(process.cwd(), '.', 'public', fileName);

    await workbook.xlsx.writeFile(filePath);

    const endTime = Date.now();
    const responseTime = endTime - startTime;

    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/settle/galaxia/excel-download',
      actionType: 'EXCEL_DOWNLOAD',
      ipAddress: '',
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime,
      downloadReason,
      recordCount: sheet.rowCount - 1,
      requestParams: { startAt, endAt, businessName, appDiv },
    });

    return { fileName, filePath };
  }
}
