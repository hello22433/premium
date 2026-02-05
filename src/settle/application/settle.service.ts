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
  SettleGetUserDetailMultipleReqQueryDto,
  SettleGetUserExcelDownloadReqDto,
  SettleGetUserListReqQueryDto,
  SettleGetUserPerDetailReqQueryDto,
  SettleGetUserPerListReqQueryDto,
  SettleMobileExcelDownloadReqDto,
  SettlePartnerCompanyExcelDownloadReqDto,
  SettlerUpdateOtherSaleReqDto,
  SettleUpdateUserPerOrderReqDto,
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
} from '../../common/domain/date.format.str';
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
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
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
import { CryptoCipher } from '../../common/infra/crypto.cipher';

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
    private activityLogService: ActivityLogService,
    private cryptoCipher: CryptoCipher,
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
    const { startAt, endAt, personName, businessName, eventName, page, take } = getQuery;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
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
      queryBuilder = queryBuilder.andWhere('userCompany.businessName LIKE :businessName', {
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
          businessName: order.user!.company?.businessName ?? '',
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
      .leftJoinAndSelect('user.company', 'userCompany')
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
      queryBuilder = queryBuilder.andWhere('userCompany.businessName LIKE :businessName', {
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
          businessName: order.user!.company?.businessName ?? '',
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

    // OrderDelivery 기준으로 직접 쿼리하여 DB 레벨 페이징 적용
    let queryBuilder = this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoinAndSelect('orderDelivery.orderProductMapping', 'orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('partnerCompany.userDiscounts', 'partnerDiscounts')
      .leftJoinAndSelect('product.brand', 'brand')
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
      const matchingDiscount = this.findMatchingDiscount(
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

      let usePrice = 0;
      let unUsePrice = 0;

      if (partnerCompany.type === IPartnerCompanyType.GALAXIA) {
        usePrice = product.price - orderDelivery.galaxiaBalance;
        unUsePrice = orderDelivery.galaxiaBalance;
      }

      return {
        id: order.id,
        registeredAt: format(orderDelivery.sendRequestAt, DateFormatStr),
        partnerCompanyName: partnerCompany.businessName,
        userBusinessName: order.user!.company?.businessName ?? '',
        eventName: order.eventName,
        code: order.code,
        productNameList: [product.name],
        deliveryPrice: product.price,
        settlePrice: settlePrice,
        fee: fee,
        feePrice: feePrice,
        usePrice: usePrice,
        unUsePrice: unUsePrice,
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

    const { startAt, endAt, settleMethod, businessName, downloadReason } = body;

    const now = new Date();
    const nowString = format(now, 'yyyyMMdd');

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .leftJoinAndSelect('partnerCompany.userDiscounts', 'partnerDiscounts')
      .leftJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .leftJoinAndSelect('orderDeliveries.choiceSelectProduct', 'choiceSelectProduct')
      .leftJoinAndSelect('choiceSelectProduct.partnerCompany', 'choicePartnerCompany')
      .leftJoinAndSelect('choiceSelectProduct.brand', 'choiceBrand')
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

    // 핀 상태 한글 변환
    const couponStatusToKorean = (status: string): string => {
      switch (status) {
        case 'NOT_USED':
          return '미사용';
        case 'USED':
          return '사용';
        case 'CANCEL':
          return '취소';
        case 'REFUND_CANCEL':
          return '환불취소';
        case 'EXPIRED':
          return '기간만료';
        default:
          return status;
      }
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
          let receiverPhone = '';
          if (orderDelivery.deliveryTarget) {
            try {
              receiverPhone = this.cryptoCipher.decryptDeliveryTarget(orderDelivery.deliveryTarget);
            } catch {
              receiverPhone = orderDelivery.deliveryTarget;
            }
          }

          // 유효기간 계산 (기호 없이 yyyyMMdd 형식)
          let validityStartAt = '';
          let validityEndAt = '';
          if (orderDelivery.actualSendAt) {
            const sendDateObj = new Date(orderDelivery.actualSendAt);
            // 협력사 설정에 따라 시작일 계산 (초이스쿠폰 선택 시 선택된 상품의 협력사 설정 사용)
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
            userBusinessName: order.user!.company?.businessName ?? '',
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
    const { startAt, endAt, isPublished, businessName, personName, eventName, page, take } = getQuery;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientUserCompany')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .leftJoinAndSelect('product.classification', 'classification')
      .leftJoinAndSelect('product.brand', 'brand')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .leftJoinAndSelect('user.userDiscounts', 'userDiscounts')
      .leftJoinAndSelect('clientUser.userDiscounts', 'clientUserDiscounts')
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
      queryBuilder = queryBuilder.andWhere('userCompany.businessName LIKE :businessName', {
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

      // 과금 대상 사용자 (대행주문인 경우 clientUser, 아니면 user)
      const billingUser = order.clientUser ?? order.user;
      const userDiscounts = billingUser?.userDiscounts || [];

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
              adjustedPrice = Math.ceil((productTotalPrice * (100 - orderProductMapping.fee)) / 100);
            } else if (orderProductMapping.priceAdjustment === IPriceAdjustment.ADDITIONAL) {
              adjustedPrice = Math.ceil((productTotalPrice * (100 + orderProductMapping.fee)) / 100);
            }
          }
          finalSettlePrice += adjustedPrice;
        } else {
          // 2. 저장된 값이 없으면 userDiscounts에서 매칭되는 할인 설정 찾기
          const matchingDiscount = this.findMatchingDiscount(
            {
              price: product.price,
              category: product.category,
              brand: product.brand,
            },
            userDiscounts,
          );

          // 할인/할증 적용
          const discountedPrice = this.applyDiscount(productTotalPrice, matchingDiscount);
          finalSettlePrice += discountedPrice;
        }
      }

      // 첫 번째 배송의 실제 발송 시간 사용
      const firstDelivery = order.orderProductMappings?.[0]?.orderDeliveries?.[0];
      const sendRequestAt = firstDelivery?.actualSendAt ? format(firstDelivery.actualSendAt, DateFormatStr) : null;

      // 발송완료 리포트 상태 계산
      let deliveryReportStatus = '-';
      if (order.deliveryCompleteReportCount > 0) {
        const isReissue = order.deliveryCompleteReportCount > 1;
        if (order.deliveryReportLastSource === 'DIRECT') {
          deliveryReportStatus = isReissue ? '발행(재)' : '발행 완료';
        } else {
          deliveryReportStatus = isReissue ? '다운로드(재)' : '다운로드 완료';
        }
      }

      // 거래명세서 상태 계산
      let transactionStatementStatus = '-';
      if (order.orderCompleteReportCount > 0) {
        const isReissue = order.orderCompleteReportCount > 1;
        if (order.transactionStatementLastSource === 'DIRECT') {
          transactionStatementStatus = isReissue ? '발행(재)' : '발행 완료';
        } else {
          transactionStatementStatus = isReissue ? '다운로드(재)' : '다운로드 완료';
        }
      }

      return {
        id: order.id,
        registeredAt: format(order.registerAt, DateFormatStr),
        businessName: billingUser?.company?.businessName ?? '',
        personName: billingUser?.personName ?? '',
        eventName: order.eventName,
        productNameList: productNameList,
        amount: amount,
        deliveryPrice: order.sendAmount,
        originalSettlePrice: order.settleAmount,
        settlePrice: finalSettlePrice,
        status: order.status,
        sendRequestAt: sendRequestAt,
        deliveryReportStatus,
        transactionStatementStatus,
      };
    });

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  async getUserDetail(getParam: SettleGetUserDetailReqParamDto): Promise<SettleGetUserDetailResDto> {
    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientUserCompany')
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

    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .leftJoinAndSelect('order.clientUser', 'clientUser')
      .leftJoinAndSelect('clientUser.company', 'clientUserCompany')
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

    const { startAt, endAt, isPublished, businessName, personName, eventName, downloadReason } = getBody;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .leftJoinAndSelect('user.company', 'userCompany')
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
      queryBuilder = queryBuilder.andWhere('userCompany.businessName LIKE :businessName', {
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
        businessName: order.user!.company?.businessName ?? '',
        personName: order.user!.personName,
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

    const queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.company', 'userCompany')
      .innerJoinAndSelect('user.orders', 'orders')
      .innerJoinAndSelect('orders.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries');

    // 날짜 기준 타입에 따라 필터링 (기본값: 등록일)
    const dateColumn = dateType === 'ACTUAL_SEND_AT' ? 'actualSendAt' : 'createdAt';
    QueryBuilderDateCondition(queryBuilder, 'orderDeliveries', dateColumn, startAt, endAt);

    if (userPersonName) {
      queryBuilder.andWhere('user.personName LIKE :userPersonName', { userPersonName: `%${userPersonName}%` });
    }

    if (userBusinessName) {
      queryBuilder.andWhere('userCompany.businessName LIKE :userBusinessName', {
        userBusinessName: `%${userBusinessName}%`,
      });
    }

    // 상태 필터링은 회사별 합산 후에 적용

    queryBuilder.orderBy('user.id', 'DESC');

    const allUsers = await queryBuilder.getMany();

    // 동일 회사별 allSettleAmount 합산 (companyId -> totalAllSettleAmount)
    const companyAllSettleMap = new Map<number, number>();

    for (const user of allUsers) {
      const companyId = user.companyId;
      if (!companyId) continue;

      if (!companyAllSettleMap.has(companyId)) {
        companyAllSettleMap.set(companyId, 0);
      }
      companyAllSettleMap.set(companyId, companyAllSettleMap.get(companyId)! + user.allSettleAmount);
    }

    // 결과 리스트 생성 (회사별 합산된 allSettleAmount 사용)
    let result: SettleUserPerListViewDto[] = allUsers.map((user) => {
      let overdueCount = 0;
      let overdueAmount = 0;
      for (const order of user.orders!) {
        if (order.status === 'DELIVERY_COMPLETE' && order.settleStatus === 'UNSETTLE_OVERDUE') {
          overdueCount += 1;
          overdueAmount += order.sendAmount;
        }
      }

      const companyMaximumLimit = Number(user.company?.maximumLimit ?? 0);
      const companyId = user.companyId;

      // 잔여서비스한도 = 회사최대한도 + 개별balance - 회사전체allSettleAmount
      let remainServiceAmount: number;
      if (companyId && companyAllSettleMap.has(companyId)) {
        const totalAllSettleAmount = companyAllSettleMap.get(companyId)!;
        remainServiceAmount = companyMaximumLimit + user.balance - totalAllSettleAmount;
      } else {
        // 회사가 없는 경우 개별 계산
        remainServiceAmount = user.balance - user.allSettleAmount;
      }

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
        overdueCount: overdueCount,
        overdueAmount: overdueAmount,
        balance: user.balance,
        remainServiceAmount: remainServiceAmount,
        status: remainServiceAmount > 0 ? SettleUserStatusEnum.ACTIVE : SettleUserStatusEnum.STOP,
      };
    });

    // 상태 필터링 적용 (회사별 합산 후)
    if (status) {
      if (status === 'ACTIVE') {
        result = result.filter((r) => r.remainServiceAmount > 0);
      }
      if (status === 'STOP') {
        result = result.filter((r) => r.remainServiceAmount <= 0);
      }
    }

    const totalCount = result.length;

    // 페이지네이션 적용
    const skip = (page - 1) * take;
    const paginatedResult = result.slice(skip, skip + take);

    return {
      list: paginatedResult,
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
      .leftJoinAndSelect('user.company', 'userCompany')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .innerJoinAndSelect('orderProductMappings.orderDeliveries', 'orderDeliveries')
      .where('order.userId = :userId', { userId: userId })
      .andWhere('order.status IN (:...status)', { status: ['DELIVERY_CONFIRMED', 'DELIVERY_COMPLETE'] });

    QueryBuilderDateCondition(queryBuilder, 'orderProductMappings', 'sendRequestAt', startAt, endAt);

    if (userBusinessName) {
      queryBuilder.andWhere('userCompany.businessName LIKE :userBusinessName', {
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
      if (order.orderProductMappings && order.orderProductMappings.length > 0) {
        productName = order.orderProductMappings[0].product.name;
        const orderProductMappingsLength = order.orderProductMappings.length;
        if (orderProductMappingsLength - 1 > 0) {
          productName += `외 ${orderProductMappingsLength - 1}건`;
        }
      }

      // 첫 번째 배송의 실제 발송 시간 사용
      const firstDelivery = order.orderProductMappings?.[0]?.orderDeliveries?.[0];
      const sendRequestAt = firstDelivery?.actualSendAt ? format(firstDelivery.actualSendAt, DateFormatStr) : null;

      return {
        id: order.id,
        userBusinessName: order.user!.company?.businessName ?? '',
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
   * - 잔여서비스한도 = 회사최대한도 + 개별balance - 회사전체allSettleAmount
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

    // 잔여발송한도 = 회사최대한도 + 개별balance - 회사전체allSettleAmount
    const remainServiceAmount = companyMaximumLimit + userEntity.balance - totalAllSettleAmount;

    return {
      maximumLimit: companyMaximumLimit,
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
    product: { price: number; category: string; brand?: { nameKorean: string } | null },
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
