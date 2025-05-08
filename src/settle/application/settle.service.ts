import { BadRequestException, Injectable } from '@nestjs/common';
import {
  SettleGetAdminUserListResDto,
  SettleGetMobileListResDto,
  SettleGetOtherDetailResDto,
  SettleGetOtherListResDto,
  SettleGetPartnerCompanyListResDto,
  SettleGetSaleTypeListResDto,
  SettleGetShippingStorageListResDto,
  SettleGetUserDetailResDto,
  SettleGetUserListResDto,
} from '../api/settle.res.dto';
import { OrderEntity } from '../../entity/order.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
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
  SettleMobileExcelDownloadReqDto,
  SettlerUpdateOtherSaleReqDto,
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
    const cardFeePercent = 5; // 백분율 1~100사이
    const mmsFee = 5; //

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
          productClassification: orderProductMapping.product.classification,
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

  async mobileExcelDownload(getQuery: SettleMobileExcelDownloadReqDto) {
    const { startAt, endAt, personName, businessName, eventName } = getQuery;

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
    const cardFeePercent = 5; // 백분율 1~100사이
    const mmsFee = 5; //

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
          productClassification: orderProductMapping.product.classification,
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

          const settlePrice =
            orderProductMapping.priceAdjustment === 'DISCOUNT'
              ? orderProductMapping.product.price - feePrice
              : orderProductMapping.product.price + feePrice;
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

      for (const orderProductMapping of order.orderProductMappings!) {
        productNameList.push(orderProductMapping.product.name);
        amount += orderProductMapping.amount;
      }

      // 기본 정산 금액
      let finalSettlePrice = order.settleAmount;

      // 할인 옵션 적용
      if (order.user && order.user.userDiscounts && order.user.userDiscounts.length > 0) {
        const discountData = order.user.userDiscounts[0]; // 초기값 설정
        if (discountData.priceAdjustment === IPriceAdjustment.DISCOUNT) {
          finalSettlePrice = (order.settleAmount * (100 - discountData.pricePercent)) / 100;
        } else if (discountData.priceAdjustment === IPriceAdjustment.ADDITIONAL) {
          finalSettlePrice = (order.settleAmount * (100 + discountData.pricePercent)) / 100;
        }
      }

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
        sendRequestAt: format(order.sendRequestAt, DateFormatStr),
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
        const product = orderProductMapping.product
          ? {
              id: orderProductMapping.product.id,
              code: orderProductMapping.product.code,
              brandName: orderProductMapping.product.brand?.nameKorean ?? '',
              name: orderProductMapping.product.name,
              price: orderProductMapping.product.price,
              amount: orderProductMapping.amount,
            }
          : null;
        productList.push({
          id: orderProductMapping.id,
          product: product,
        });
      }
    }

    const sendRequestAt = normalizeDate(order.sendRequestAt) ? format(order.sendRequestAt, DateFormatStr) : null;

    return {
      id: order.id,
      userId: order.userId,
      userPersonName: order.user!.personName,
      userBusinessName: order.user!.businessName,
      operationPersonName: order.operationUser?.personName ?? null,
      eventName: order.eventName,
      type: order.type,
      sendTitle: order.sendTitle,
      sendContent: order.sendContent,
      sendRequestAt: sendRequestAt,
      status: order.status,
      productList: productList,
    };
  }

  async getUserExcelDownload(getBody: SettleGetUserExcelDownloadReqDto) {
    const { startAt, endAt, isPublished, businessName, personName, eventName } = getBody;

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
        sendRequestAt: format(order.sendRequestAt, DateEndMinuteFormatStr),
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

    return { fileName, filePath };
  }
}
