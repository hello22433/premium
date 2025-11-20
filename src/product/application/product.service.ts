import { BadRequestException, Injectable } from '@nestjs/common';
import { ProductEntity } from '../../entity/product.entity';
import { FindOptionsWhere, In, Like, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ClassificationGetSearchListReqDto,
  ProductCreateReqDto,
  ProductDeleteReqDto,
  ProductExcelDownloadReqBodyDto,
  ProductGetDetailReqParamDto,
  ProductGetListReqQueryDto,
  ProductGetTotalListReqQueryDto,
  ProductGetUpdateHistoryReqParamDto,
  ProductGetUpdateHistoryReqQueryDto,
  ProductSetLikeReqDto,
  ProductSsgReqQueryDto,
  ProductUpdatePartialReqDto,
} from '../api/product.req.dto';
import { ProductViewDto } from '../api/dto/product.view.dto';
import { ClassificationViewDto } from '../api/dto/classification.view.dto';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import {
  ClassificationGetSearchListResDto,
  ProductGetDetailResDto,
  ProductGetListResDto,
  ProductGetSsgResDto,
  ProductGetUpdateHistoryResDto,
} from '../api/product.res.dto';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { BrandEntity } from '../../entity/brand.entity';
import { ClassificationEntity } from '../../entity/classification.entity';
import { CreateCode } from '../../common/domain/create.code';
import { ProductChoicePrefixCode, ProductDigitNumber, ProductPrefixCode } from '../domain/product.code';
import { ProductUpdateHistoryEntity } from '../../entity/product.update.history.entity';
import { ProductUpdateHistoryKeyName } from '../domain/product.update.history.key.name';
import { Transactional } from 'typeorm-transactional';
import { ProductHistoryViewDto } from '../api/dto/product.history.view.dto';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { join } from 'path';
import * as process from 'node:process';
import * as ExcelJS from 'exceljs';
import {
  ProductSettleMethodExcelMapping,
  ProductTypeExcelMapping,
  ProductUseStatusExcelMapping,
} from '../domain/product.excel.mapping';
import { IProductType } from '../interface/product.type';
import { IUserAuthority } from '../../user/interface/user.authority';
import { UserSyncProductEventEntity } from '../../entity/user.sync.product.event.entity';
import { ProductLikeEntity } from '../../entity/product.like.entity';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { validate } from 'class-validator';
import {
  ProductSettleMethodExcelToDbMapping,
  ProductTypeExcelToDBMapping,
  ProductUseStatusExcelToDBMapping,
} from '../domain/product.excel.to.db.mapping';
import { listToMap } from '../../util/map.util';
import { UserEntity } from 'src/entity/user.entity';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';
import { IUserSyncProductStatus } from '../../user_sync_product/interface/user.sync.product.status';

@Injectable()
export class ProductService {
  constructor(
    @InjectRepository(ProductEntity)
    private productRepository: Repository<ProductEntity>,
    @InjectRepository(PartnerCompanyEntity)
    private partnerCompanyRepository: Repository<PartnerCompanyEntity>,
    @InjectRepository(BrandEntity)
    private brandRepository: Repository<BrandEntity>,
    @InjectRepository(ClassificationEntity)
    private classificationRepository: Repository<ClassificationEntity>,
    @InjectRepository(ProductUpdateHistoryEntity)
    private productUpdateHistoryRepository: Repository<ProductUpdateHistoryEntity>,
    @InjectRepository(UserSyncProductEventEntity)
    private userSyncProductEventRepository: Repository<UserSyncProductEventEntity>,
    @InjectRepository(ProductLikeEntity)
    private productLikeRepository: Repository<ProductLikeEntity>,
    @InjectRepository(SsgEventEntity)
    private ssgEventRepository: Repository<SsgEventEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private activityLogService: ActivityLogService,
  ) {}

  async getTotalList(user: ILoginUserInfo, getQuery: ProductGetTotalListReqQueryDto): Promise<ProductGetListResDto> {
    const {
      partnerCompanyId,
      brandId,
      brandName,
      name,
      useStatus,
      code,
      partnerCompanyCode,
      type,
      isLike,
      page,
      take,
      isChoiceType,
    } = getQuery;
    let queryBuilder = this.productRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.classification', 'classification')
      .leftJoinAndSelect('product.productLikes', 'productLikes')
      .andWhere('product.type != :ssg', { ssg: IProductType.SSG });

    if (user.authority === IUserAuthority.CORPORATE_ADMIN) {
      const event = await this.userSyncProductEventRepository.findOne({
        where: { businessUserId: user.id },
        relations: ['userSyncProductEventMappings'],
      });

      const mappedProductIds = event?.userSyncProductEventMappings?.map((m) => m.productId);

      // event 가 없거나 매핑된 상품이 없는 경우 빈 리스트 반환
      if (!mappedProductIds || mappedProductIds.length === 0) {
        queryBuilder = queryBuilder.andWhere('1 = 0');
      } else {
        queryBuilder = queryBuilder.andWhere('product.id IN (:...mappedProductIds)', {
          mappedProductIds,
        });
      }
    }

    if (type && !isChoiceType) {
      if (type !== IProductType.GENERAL) {
        queryBuilder = queryBuilder.andWhere('product.type = :type', { type });
      }

      if (type === IProductType.GENERAL) {
        queryBuilder = queryBuilder
          .andWhere('product.type IN (:...type)', { type: [IProductType.GENERAL, IProductType.SELF] })
          .andWhere('partnerCompany.type IS NOT NULL')
          .andWhere('partnerCompany.type != :ssg', { ssg: 'SSG' });
      }
    }

    if (type && isChoiceType) {
      if (type === IProductType.GENERAL) {
        queryBuilder = queryBuilder.andWhere('product.type IN (:...type)', {
          type: [IProductType.GENERAL, IProductType.CHOICE, IProductType.SELF],
        });
        // .andWhere('partnerCompany.type IS NOT NULL')
        // .andWhere('partnerCompany.type != :ssg', { ssg: 'SSG' });
      }
    }

    if (partnerCompanyId) {
      queryBuilder = queryBuilder.andWhere('product.partnerCompanyId = :partnerCompanyId', { partnerCompanyId });
    }

    if (brandId) {
      queryBuilder = queryBuilder.andWhere('product.brandId = :brandId', { brandId });
    }

    if (brandName) {
      queryBuilder = queryBuilder.andWhere('brand.nameKorean LIKE :brandName', { brandName: `%${brandName}%` });
      queryBuilder = queryBuilder.andWhere('brand.nameEnglish LIKE :brandName', { brandName: `%${brandName}%` });
    }

    if (name) {
      queryBuilder = queryBuilder.andWhere('product.name LIKE :name', { name: `%${name}%` });
    }

    if (useStatus) {
      queryBuilder = queryBuilder.andWhere('product.useStatus = :useStatus', { useStatus });
    }

    if (code) {
      queryBuilder = queryBuilder.andWhere('product.code LIKE :code', { code: `%${code}%` });
    }

    if (partnerCompanyCode) {
      queryBuilder = queryBuilder.andWhere('partnerCompany.code LIKE :partnerCompanyCode', {
        partnerCompanyCode: `%${partnerCompanyCode}%`,
      });
    }

    if (isLike !== undefined) {
      queryBuilder = queryBuilder
        .andWhere('productLikes.userId = :userId', { userId: user.id })
        .andWhere('productLikes.isLike = :isLike', { isLike });
    }

    queryBuilder = queryBuilder.orderBy('product.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.skip(skip).take(take);

    const [productList, totalCount] = await queryBuilder.getManyAndCount();

    const productIdList = productList.map((product) => product.id);

    const productUpdateHistoryList = await this.productUpdateHistoryRepository.find({
      where: {
        productId: In(productIdList),
      },
    });

    // <product.id, isChange> 변경 여부 boolean 값 설정
    const productUpdateBooleanMap = new Map<number, boolean>();
    for (const updateHistory of productUpdateHistoryList) {
      productUpdateBooleanMap.set(updateHistory.productId, true);
    }

    const resultList: ProductViewDto[] = productList.map((product) => {
      const isChange = productUpdateBooleanMap.get(product.id) ?? false;
      let isLike = false;
      if (product.productLikes) {
        for (const productLike of product.productLikes) {
          if (productLike.userId === user.id) {
            isLike = productLike.isLike;
            break;
          }
        }
      }

      return {
        id: product.id,
        createdAt: format(product.createdAt, DateFormatStr),
        type: product.type,
        code: product.code,
        partnerCompanyCode: product.partnerCompanyCode,
        partnerCompanyId: product.partnerCompanyId,
        partnerCompanyName: product.partnerCompany!.businessName,
        classification: product.classification?.classification ?? null,
        brandId: product.brandId,
        brandName: product.brand!.nameKorean,
        name: product.name,
        price: product.price,
        expireDay: product.expireDay,
        category: product.category,
        useStatus: product.useStatus,
        imagePath: product.imagePath,
        isChange,
        isLike,
      };
    });

    const totalPage = Math.ceil(totalCount / take);

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  async getList(user: ILoginUserInfo, getQuery: ProductGetListReqQueryDto): Promise<ProductGetListResDto> {
    const {
      partnerCompanyId,
      headPersonUserId,
      brandId,
      brandName,
      name,
      useStatus,
      code,
      partnerCompanyCode,
      type,
      isLike,
      page,
      take,
      isChoiceType,
    } = getQuery;
    let queryBuilder = this.productRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.classification', 'classification')
      .leftJoinAndSelect('product.productLikes', 'productLikes')
      .andWhere('product.type != :ssg', { ssg: IProductType.SSG });

    if (headPersonUserId) {
      const events = await this.userSyncProductEventRepository.find({
        where: {
          businessUserId: headPersonUserId,
          status: IUserSyncProductStatus.ACTIVE,
        },
        relations: ['userSyncProductEventMappings'],
      });

      const mappedProductIds: number[] = [];
      for (const event of events) {
        if (event.userSyncProductEventMappings) {
          for (const mapping of event.userSyncProductEventMappings) {
            mappedProductIds.push(mapping.productId);
          }
        }
      }
      const uniqueProductIds = [...new Set(mappedProductIds)];
      if (uniqueProductIds.length === 0) {
        queryBuilder = queryBuilder.andWhere('1 = 0');
      } else {
        queryBuilder = queryBuilder.andWhere('product.id IN (:...mappedProductIds)', {
          mappedProductIds: uniqueProductIds,
        });
      }
    }

    if (user.authority === IUserAuthority.CORPORATE_ADMIN) {
      const event = await this.userSyncProductEventRepository.findOne({
        where: { businessUserId: user.id },
        relations: ['userSyncProductEventMappings'],
      });

      const mappedProductIds = event?.userSyncProductEventMappings?.map((m) => m.productId);

      if (!mappedProductIds || mappedProductIds.length === 0) {
        queryBuilder = queryBuilder.andWhere('1 = 0');
      } else {
        queryBuilder = queryBuilder.andWhere('product.id IN (:...mappedProductIds)', {
          mappedProductIds,
        });
      }
    }

    if (type && !isChoiceType) {
      if (type !== IProductType.GENERAL) {
        queryBuilder = queryBuilder.andWhere('product.type = :type', { type });
      }

      if (type === IProductType.GENERAL) {
        queryBuilder = queryBuilder
          .andWhere('product.type IN (:...type)', { type: [IProductType.GENERAL, IProductType.SELF] })
          .andWhere('partnerCompany.type IS NOT NULL')
          .andWhere('partnerCompany.type != :ssg', { ssg: 'SSG' });
      }
    }

    if (type && isChoiceType) {
      if (type === IProductType.GENERAL) {
        queryBuilder = queryBuilder.andWhere('product.type IN (:...type)', {
          type: [IProductType.GENERAL, IProductType.CHOICE, IProductType.SELF],
        });
        // .andWhere('partnerCompany.type IS NOT NULL')
        // .andWhere('partnerCompany.type != :ssg', { ssg: 'SSG' });
      }
    }

    if (partnerCompanyId) {
      queryBuilder = queryBuilder.andWhere('product.partnerCompanyId = :partnerCompanyId', { partnerCompanyId });
    }

    if (brandId) {
      queryBuilder = queryBuilder.andWhere('product.brandId = :brandId', { brandId });
    }

    if (brandName) {
      queryBuilder = queryBuilder.andWhere('brand.nameKorean LIKE :brandName', { brandName: `%${brandName}%` });
      queryBuilder = queryBuilder.andWhere('brand.nameEnglish LIKE :brandName', { brandName: `%${brandName}%` });
    }

    if (name) {
      queryBuilder = queryBuilder.andWhere('product.name LIKE :name', { name: `%${name}%` });
    }

    if (useStatus) {
      queryBuilder = queryBuilder.andWhere('product.useStatus = :useStatus', { useStatus });
    }

    if (code) {
      queryBuilder = queryBuilder.andWhere('product.code LIKE :code', { code: `%${code}%` });
    }

    if (partnerCompanyCode) {
      queryBuilder = queryBuilder.andWhere('partnerCompany.code LIKE :partnerCompanyCode', {
        partnerCompanyCode: `%${partnerCompanyCode}%`,
      });
    }

    if (isLike !== undefined) {
      queryBuilder = queryBuilder
        .andWhere('productLikes.userId = :userId', { userId: user.id })
        .andWhere('productLikes.isLike = :isLike', { isLike });
    }

    queryBuilder = queryBuilder.orderBy('product.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.skip(skip).take(take);

    const [productList, totalCount] = await queryBuilder.getManyAndCount();

    const productIdList = productList.map((product) => product.id);

    const productUpdateHistoryList = await this.productUpdateHistoryRepository.find({
      where: {
        productId: In(productIdList),
      },
    });

    // <product.id, isChange> 변경 여부 boolean 값 설정
    const productUpdateBooleanMap = new Map<number, boolean>();
    for (const updateHistory of productUpdateHistoryList) {
      productUpdateBooleanMap.set(updateHistory.productId, true);
    }

    const resultList: ProductViewDto[] = productList.map((product) => {
      const isChange = productUpdateBooleanMap.get(product.id) ?? false;
      let isLike = false;
      if (product.productLikes) {
        for (const productLike of product.productLikes) {
          if (productLike.userId === user.id) {
            isLike = productLike.isLike;
            break;
          }
        }
      }

      return {
        id: product.id,
        createdAt: format(product.createdAt, DateFormatStr),
        type: product.type,
        code: product.code,
        partnerCompanyCode: product.partnerCompanyCode,
        partnerCompanyId: product.partnerCompanyId,
        partnerCompanyName: product.partnerCompany!.businessName,
        classification: product.classification?.classification ?? null,
        brandId: product.brandId,
        brandName: product.brand!.nameKorean,
        name: product.name,
        price: product.price,
        expireDay: product.expireDay,
        category: product.category,
        useStatus: product.useStatus,
        imagePath: product.imagePath,
        isChange,
        isLike,
      };
    });

    const totalPage = Math.ceil(totalCount / take);

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  async getSsg(getQuery: ProductSsgReqQueryDto): Promise<ProductGetSsgResDto> {
    const { price } = getQuery;

    // 먼저 해당 가격의 기존 SSG 상품을 찾아봄
    let product = await this.productRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.classification', 'classification')
      .where('product.price = :price', { price })
      .andWhere('product.type = :type ', { type: IProductType.SSG })
      .andWhere('partnerCompany.type = :type', { type: IPartnerCompanyType.SSG })
      .getOne();

    // 기존 상품이 있으면 바로 반환
    if (product) {
      return {
        id: product.id,
        partnerCompanyId: product.partnerCompanyId,
        partnerCompanyName: product.partnerCompany!.businessName,
        classification: product.classification?.classification ?? null,
        brandId: product.brandId,
        brandName: product.brand!.nameKorean,
        name: product.name,
        price: product.price,
        expireDay: product.expireDay,
        imagePath: product.imagePath,
      };
    }

    // 기존 상품이 없으면 템플릿으로 사용할 기존 SSG 상품을 찾음
    const templateProduct = await this.productRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.classification', 'classification')
      .where('product.type = :type', { type: IProductType.SSG })
      .andWhere('partnerCompany.type = :type', { type: IPartnerCompanyType.SSG })
      .orderBy('product.id', 'ASC') // 가장 오래된 SSG 상품을 템플릿으로 사용
      .getOne();

    if (!templateProduct) {
      throw new BadRequestException('SSG 상품 템플릿을 찾을 수 없습니다.');
    }

    // 새로운 상품 코드 생성 (기존 패턴 따라 생성)
    const latestProduct = await this.productRepository
      .createQueryBuilder('product')
      .where('product.code LIKE :codePattern', { codePattern: 'EP%' })
      .orderBy('product.id', 'DESC')
      .getOne();

    let nextCodeNumber = 1;
    if (latestProduct && latestProduct.code.match(/EP(\d+)/)) {
      const currentNumber = parseInt(latestProduct.code.match(/EP(\d+)/)![1]);
      nextCodeNumber = currentNumber + 1;
    }
    const newCode = `EP${nextCodeNumber.toString().padStart(11, '0')}`;

    // 새로운 SSG 상품 생성
    const newProduct = new ProductEntity();
    newProduct.code = newCode;
    newProduct.partnerCompanyId = templateProduct.partnerCompanyId;
    newProduct.partnerCompanyCode = templateProduct.partnerCompanyCode;
    newProduct.brandId = templateProduct.brandId;
    newProduct.name = `신세계 상품권 ${price.toLocaleString()}원`;
    newProduct.price = price;
    // SSG 이벤트의 쿠폰 유효기간을 조회하여 사용
    const currentSsgEvent = await this.ssgEventRepository
      .createQueryBuilder('ssgEvent')
      .where('ssgEvent.startAt <= :now', { now: new Date() })
      .andWhere('ssgEvent.endAt >= :now', { now: new Date() })
      .orderBy('ssgEvent.id', 'DESC')
      .getOne();

    newProduct.expireDay = currentSsgEvent?.couponExpiration || 60; // SSG 이벤트의 쿠폰 유효기간 또는 기본값 60일
    newProduct.category = templateProduct.category;
    newProduct.classificationId = templateProduct.classificationId;
    newProduct.settleMethod = templateProduct.settleMethod;
    newProduct.settlePercent = templateProduct.settlePercent;
    newProduct.imagePath = templateProduct.imagePath;
    newProduct.type = IProductType.SSG;
    newProduct.couponMethod = templateProduct.couponMethod;
    newProduct.memo = templateProduct.memo;
    newProduct.useStatus = templateProduct.useStatus;
    newProduct.color = templateProduct.color;
    newProduct.status = templateProduct.status;

    // 데이터베이스에 새 상품 저장
    const savedProduct = await this.productRepository.save(newProduct);

    // 저장된 상품을 다시 조회하여 관계 데이터와 함께 반환
    const newProductWithRelations = await this.productRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.classification', 'classification')
      .where('product.id = :id', { id: savedProduct.id })
      .getOne();

    return {
      id: newProductWithRelations!.id,
      partnerCompanyId: newProductWithRelations!.partnerCompanyId,
      partnerCompanyName: newProductWithRelations!.partnerCompany!.businessName,
      classification: newProductWithRelations!.classification?.classification ?? null,
      brandId: newProductWithRelations!.brandId,
      brandName: newProductWithRelations!.brand!.nameKorean,
      name: newProductWithRelations!.name,
      price: newProductWithRelations!.price,
      expireDay: newProductWithRelations!.expireDay,
      imagePath: newProductWithRelations!.imagePath,
    };
  }

  async getDetail(getParam: ProductGetDetailReqParamDto): Promise<ProductGetDetailResDto> {
    const { id } = getParam;

    const product = await this.productRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.classification', 'classification')
      .andWhere('product.id = :id', { id })
      .getOne();

    if (!product) {
      throw new BadRequestException('존재하지 않는 상품입니다.');
    }

    return {
      id: product.id,
      createdAt: format(product.createdAt, DateFormatStr),
      code: product.code,
      partnerCompanyCode: product.partnerCompanyCode,
      partnerCompanyId: product.partnerCompanyId,
      partnerCompanyName: product.partnerCompany!.businessName,
      classification: product.classification?.classification ?? null,
      brandId: product.brandId,
      brandName: product.brand!.nameKorean,
      name: product.name,
      price: product.price,
      expireDay: product.expireDay,
      category: product.category ?? null,

      settleMethod: product.settleMethod,
      settlePercent: product.settlePercent,
      imagePath: product.imagePath,
      type: product.type,
      couponMethod: product.couponMethod,
      memo: product.memo,
      useStatus: product.useStatus,
    };
  }

  async getUpdateHistory(
    getParam: ProductGetUpdateHistoryReqParamDto,
    getQuery: ProductGetUpdateHistoryReqQueryDto,
  ): Promise<ProductGetUpdateHistoryResDto> {
    const { id } = getParam;
    const { take, page } = getQuery;

    const product = await this.productRepository.findOne({
      where: {
        id,
      },
    });
    if (!product) {
      throw new BadRequestException('상품이 존재하지 않습니다.');
    }
    const whereCondition: FindOptionsWhere<ProductUpdateHistoryEntity> = { productId: product.id };

    const skip = (page - 1) * take;
    const productHistoryList = await this.productUpdateHistoryRepository.find({
      where: whereCondition,
      order: { id: 'desc' },
      take: take,
      skip: skip,
      relations: ['user'],
    });

    const totalCount = await this.productUpdateHistoryRepository.count({
      where: whereCondition,
    });
    const totalPage = Math.ceil(totalCount / take);

    const resultList: ProductHistoryViewDto[] = productHistoryList.map((productHistory) => {
      const userName = productHistory.user?.email ?? '삭제 회원';
      return {
        id: productHistory.id,
        userName,
        key: productHistory.key,
        keyName: productHistory.keyName,
        beforeValue: productHistory.beforeValue,
        afterValue: productHistory.afterValue,
        createdAt: format(productHistory.createdAt, DateFormatStr),
      };
    });

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  async create(getBody: ProductCreateReqDto) {
    const {
      partnerCompanyCode,
      partnerCompanyId,
      brandId,
      name,
      price,
      expireDay,
      category,
      classificationId,
      settlePercent,
      settleMethod,
      imagePath,
      type,
      memo,
      useStatus,
    } = getBody;

    const existBrandId = await this.brandRepository.count({ where: { id: brandId } });
    if (!existBrandId) {
      throw new BadRequestException('해당 브랜드가 존재하지 않습니다.');
    }

    const existPartnerCompanyId = await this.partnerCompanyRepository.count({ where: { id: partnerCompanyId } });
    if (!existPartnerCompanyId) {
      throw new BadRequestException('해당 협력사가 존재하지 않습니다.');
    }

    if (classificationId !== undefined && classificationId !== null) {
      const existClassificationId = await this.classificationRepository.count({ where: { id: classificationId } });
      if (!existClassificationId) {
        throw new BadRequestException('해당 대분류가 존재하지 않습니다.');
      }
    }

    const getProductPrefixCode = type === IProductType.CHOICE ? ProductChoicePrefixCode : ProductPrefixCode;

    const prevProduct = await this.productRepository.findOne({
      where: {
        code: Like(`${getProductPrefixCode}%`),
      },
      order: { code: 'DESC' },
      withDeleted: true,
    });

    const prevCodeBrand = prevProduct?.code ?? null;
    const newCode = CreateCode(prevCodeBrand, getProductPrefixCode, ProductDigitNumber);

    await this.productRepository.insert({
      partnerCompanyCode,
      partnerCompanyId,
      code: newCode,
      brandId,
      name,
      price,
      expireDay,
      category,
      classificationId,
      settlePercent,
      settleMethod,
      imagePath,
      type,
      memo,
      useStatus,
    });

    return;
  }

  @Transactional()
  async updatePartial(user: ILoginUserInfo, getBody: ProductUpdatePartialReqDto) {
    const { id, reason } = getBody;

    const product = await this.productRepository.findOne({
      where: {
        id,
      },
    });
    if (!product) {
      throw new BadRequestException('상품이 존재하지 않습니다.');
    }
    const productUpdateHistoryCreateList: ProductUpdateHistoryEntity[] = [];

    for (const key of Object.keys(getBody)) {
      // @ts-ignore
      if (getBody[key] === undefined) {
        continue;
      }
      if (key === 'id') {
        continue;
      }

      if (key === 'reason') {
        continue;
      }

      if (key === 'brandId') {
        const existBrandId = await this.brandRepository.count({ where: { id: getBody.brandId } });
        if (!existBrandId) {
          throw new BadRequestException('해당 브랜드가 존재하지 않습니다.');
        }
      }

      if (key === 'partnerCompanyId') {
        const existPartnerCompanyId = await this.partnerCompanyRepository.count({
          where: { id: getBody.partnerCompanyId },
        });
        if (!existPartnerCompanyId) {
          throw new BadRequestException('해당 협력사가 존재하지 않습니다.');
        }
      }

      if (key === 'classificationId') {
        const existClassificationId = await this.classificationRepository.count({
          where: { id: getBody.classificationId },
        });
        if (!existClassificationId) {
          throw new BadRequestException('해당 대분류가 존재하지 않습니다.');
        }
      }

      // @ts-ignore
      let beforeValue = product[key];
      // @ts-ignore
      let afterValue = getBody[key];

      // classificationId 변경 시 가독성을 위해 분류명도 함께 저장
      if (key === 'classificationId' && beforeValue !== afterValue) {
        let beforeClassificationName = null;
        let afterClassificationName = null;

        if (beforeValue) {
          const beforeClassification = await this.classificationRepository.findOne({
            where: { id: beforeValue },
          });
          beforeClassificationName = beforeClassification?.classification;
        }

        if (afterValue) {
          const afterClassification = await this.classificationRepository.findOne({
            where: { id: afterValue },
          });
          afterClassificationName = afterClassification?.classification;
        }

        // "ID: name" 형식으로 저장
        beforeValue = beforeValue ? `${beforeValue}: ${beforeClassificationName}` : null;
        afterValue = afterValue ? `${afterValue}: ${afterClassificationName}` : null;
      }

      if (beforeValue !== afterValue) {
        const productUpdateHistoryEntity = new ProductUpdateHistoryEntity();
        productUpdateHistoryEntity.productId = id;
        productUpdateHistoryEntity.userId = user.id;
        productUpdateHistoryEntity.key = key;
        productUpdateHistoryEntity.keyName = ProductUpdateHistoryKeyName(key);
        productUpdateHistoryEntity.beforeValue = beforeValue ?? null;
        productUpdateHistoryEntity.afterValue = afterValue ?? null;
        productUpdateHistoryEntity.reason = reason ?? null;
        productUpdateHistoryCreateList.push(productUpdateHistoryEntity);

        // product 정보 수정
        // @ts-ignore
        product[key] = getBody[key];
      }
    }

    await this.productRepository.save(product);
    await this.productUpdateHistoryRepository.insert(productUpdateHistoryCreateList);
    return;
  }

  async excelDownload(user: ILoginUserInfo, getBody: ProductExcelDownloadReqBodyDto) {
    const startTime = Date.now();
    const {
      partnerCompanyId,
      brandId,
      brandName,
      name,
      useStatus,
      code,
      partnerCompanyCode,
      userId,
      password,
      downloadReason,
    } = getBody;

    // 비밀번호 검증
    await this.activityLogService.verifyPassword(user.id, password);

    const now = new Date();
    const nowString = format(now, 'yyyyMMdd');

    let queryBuilder = this.productRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.classification', 'classification')
      .andWhere('product.type != :ssg', { ssg: IProductType.SSG });

    if (userId) {
      const user = await this.userRepository.findOne({
        where: { id: userId },
      });

      if (!user) {
        throw new BadRequestException('해당 고객사가 존재하지 않습니다.');
      }

      const event = await this.userSyncProductEventRepository.findOne({
        where: { businessUserId: user.id },
        relations: ['userSyncProductEventMappings'],
      });

      if (!event) {
        throw new BadRequestException('해당 고객사의 연동 이벤트가 존재하지 않습니다.');
      }

      const mappedProductIds = event.userSyncProductEventMappings?.map((m) => m.productId);

      if (mappedProductIds && mappedProductIds.length > 0) {
        queryBuilder = queryBuilder.andWhere('product.id IN (:...mappedProductIds)', { mappedProductIds });
      }
    }

    if (partnerCompanyId) {
      queryBuilder = queryBuilder.andWhere('product.partnerCompanyId = :partnerCompanyId', { partnerCompanyId });
    }

    if (brandId) {
      queryBuilder = queryBuilder.andWhere('product.brandId = :brandId', { brandId });
    }

    if (brandName) {
      queryBuilder = queryBuilder.andWhere('brand.nameKorean LIKE :brandName', { brandName: `%${brandName}%` });
      queryBuilder = queryBuilder.andWhere('brand.nameEnglish LIKE :brandName', { brandName: `%${brandName}%` });
    }

    if (name) {
      queryBuilder = queryBuilder.andWhere('product.name LIKE :name', { name: `%${name}%` });
    }

    if (useStatus) {
      queryBuilder = queryBuilder.andWhere('product.useStatus = :useStatus', { useStatus });
    }

    if (code) {
      queryBuilder = queryBuilder.andWhere('product.code LIKE :code', { code: `%${code}%` });
    }

    if (partnerCompanyCode) {
      queryBuilder = queryBuilder.andWhere('partnerCompany.code LIKE :partnerCompanyCode', {
        partnerCompanyCode: `%${partnerCompanyCode}%`,
      });
    }

    const productList = await queryBuilder.getMany();

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(`sheet1`);

    sheet.columns = [
      { header: '번호', key: 'id', width: 10 },
      { header: '등록일', key: 'createdAt', width: 32 },
      { header: '상품코드', key: 'code', width: 20 },
      { header: '협력사 id', key: 'partnerCompanyId', width: 20 },
      { header: '협력사명', key: 'partnerCompanyName', width: 20 },
      { header: '대분류', key: 'classification', width: 20 },
      { header: '브랜드 id', key: 'brandId', width: 20 },
      { header: '브랜드명', key: 'brandName', width: 20 },
      { header: '상품명', key: 'name', width: 32 },
      { header: '가격', key: 'price', width: 32 },
      { header: '유효기간', key: 'expireDay', width: 32 },
      { header: '상품군', key: 'category', width: 40 },
      { header: '상품구분', key: 'type', width: 40 },
      { header: '상품상태', key: 'useStatus', width: 40 },
      { header: '정산 방법', key: 'settleMethod', width: 40 },
      { header: '정산 조건 (퍼센트)', key: 'settlePercent', width: 40 },
      { header: '협력사 상품 코드', key: 'partnerCompanyCode', width: 40 },
      { header: '이미지경로', key: 'imagePath', width: 40 },
      { header: '메모', key: 'memo', width: 40 },
    ];

    let id = 1;
    for (const product of productList) {
      if (product.type === IProductType.SSG) {
        continue;
      }
      sheet.addRow({
        id: id,
        createdAt: format(product.createdAt, 'yyyy-MM-dd'),
        code: product.code,
        partnerCompanyId: product.partnerCompanyId,
        partnerCompanyName: product.partnerCompany!.businessName,
        classification: product.classification?.classification ?? null,
        brandId: product.brandId,
        brandName: product.brand!.nameKorean,
        name: product.name,
        price: product.price,
        expireDay: product.expireDay,
        category: product.category,
        type: ProductTypeExcelMapping(product.type),
        useStatus: ProductUseStatusExcelMapping(product.useStatus),
        settleMethod: ProductSettleMethodExcelMapping(product.settleMethod),
        settlePercent: product.settlePercent,
        partnerCompanyCode: product.partnerCompanyCode,
        imagePath: product.imagePath,
        memo: product.memo,
      });
      id++;
    }

    const fileName = `상품_리스트_${nowString}.xlsx`;
    const filePath = join(process.cwd(), '.', 'public', fileName);

    await workbook.xlsx.writeFile(filePath);

    // 성공 로그 저장
    const responseTime = Date.now() - startTime;
    const recordCount = productList.length;
    const { password: _, ...requestParams } = getBody;

    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/product/excel-download',
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

  @Transactional()
  async excelUpload(user: ILoginUserInfo, file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('업로드할 파일이 존재하지 않습니다.');
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer);

    // '결과' 시트를 찾기
    const worksheet = workbook.getWorksheet('결과');
    if (!worksheet) {
      throw new BadRequestException('엑셀 파일에 "결과" 시트가 없습니다.');
    }

    // 협력사, 브랜드, 대분류 데이터를 미리 로드하여 맵으로 만듦
    const allPartnerCompanies = await this.partnerCompanyRepository.find();
    const partnerCompanyNameMap = listToMap(allPartnerCompanies, (pc) => pc.businessName);

    const allBrands = await this.brandRepository.find();
    const brandNameMap = listToMap(allBrands, (brand) => brand.nameKorean);

    const allClassifications = await this.classificationRepository.find();
    const classificationNameMap = listToMap(allClassifications, (classification) => classification.classification);

    const codeList: string[] = [];
    for (let i = 2; i <= worksheet.actualRowCount; i++) {
      const rowIndex = i;

      const row = worksheet.getRow(rowIndex);
      const rowData = this.mapRowToDto(row);
      if (rowData.code) {
        codeList.push(rowData.code);
      }
    }

    const productList = await this.productRepository.find({
      where: {
        code: In(codeList),
      },
    });

    const productCodeMap = listToMap(productList, (product) => product.code);

    for (let i = 2; i <= worksheet.actualRowCount; i++) {
      const rowIndex = i;
      try {
        const row = worksheet.getRow(rowIndex);
        const rowData = this.mapRowToDto(row);

        // 협력사명으로 협력사 ID 조회
        const partnerCompany = partnerCompanyNameMap.get(rowData.partnerCompanyName?.trim());
        if (!partnerCompany) {
          throw new BadRequestException(`행 ${rowIndex}: 협력사명 "${rowData.partnerCompanyName}"을 찾을 수 없습니다.`);
        }

        // 브랜드명으로 브랜드 ID 조회
        const brand = brandNameMap.get(rowData.brandName?.trim());
        if (!brand) {
          throw new BadRequestException(`행 ${rowIndex}: 브랜드명 "${rowData.brandName}"을 찾을 수 없습니다.`);
        }

        // 대분류명으로 대분류 ID 조회
        const classification = classificationNameMap.get(rowData.classificationName?.trim());
        if (!classification) {
          throw new BadRequestException(`행 ${rowIndex}: 대분류 "${rowData.classificationName}"을 찾을 수 없습니다.`);
        }

        const createDto = new ProductCreateReqDto();
        createDto.partnerCompanyId = partnerCompany.id;
        createDto.classificationId = classification.id;
        createDto.brandId = brand.id;
        createDto.name = rowData.name?.trim();
        createDto.price = +rowData.price;
        createDto.expireDay = +rowData.expireDay;
        createDto.category = rowData.category?.trim();
        createDto.type = ProductTypeExcelToDBMapping(rowData.type?.trim());
        createDto.useStatus = ProductUseStatusExcelToDBMapping(rowData.useStatus?.trim());
        createDto.settleMethod = ProductSettleMethodExcelToDbMapping(rowData.settleMethod?.trim());
        createDto.settlePercent = +rowData.settlePercent;
        createDto.partnerCompanyCode = rowData.partnerCompanyCode;
        createDto.imagePath = rowData.imagePath;
        createDto.memo = rowData.memo;

        const validationErrors = await validate(createDto);
        if (validationErrors.length > 0) {
          console.error(JSON.stringify(validationErrors));
          throw new BadRequestException(`행 ${rowIndex} 검증 실패: 필수값 누락 혹은 형식 오류가 있습니다.`);
        }

        const existingProduct = productCodeMap.get(rowData.code);

        if (existingProduct) {
          const updateDto = new ProductUpdatePartialReqDto();
          updateDto.id = existingProduct.id;
          updateDto.reason = `엑셀 업로드(row ${rowIndex})`;

          updateDto.partnerCompanyId = partnerCompany.id;
          updateDto.classificationId = classification.id;
          updateDto.brandId = brand.id;
          updateDto.name = rowData.name?.trim();
          updateDto.price = +rowData.price;
          updateDto.expireDay = +rowData.expireDay;
          updateDto.category = rowData.category?.trim();
          updateDto.type = ProductTypeExcelToDBMapping(rowData.type?.trim());
          updateDto.useStatus = ProductUseStatusExcelToDBMapping(rowData.useStatus?.trim());
          updateDto.settleMethod = ProductSettleMethodExcelToDbMapping(rowData.settleMethod?.trim());
          updateDto.settlePercent = +rowData.settlePercent;
          updateDto.partnerCompanyCode = rowData.partnerCompanyCode;
          updateDto.imagePath = rowData.imagePath;
          updateDto.memo = rowData.memo;

          await this.updatePartial(user, updateDto);
        } else {
          await this.create(createDto);
        }
      } catch (error) {
        const msg =
          error instanceof BadRequestException
            ? error.message
            : `행 ${rowIndex} 처리 중 알 수 없는 오류가 발생했습니다: ${error.message}`;
        throw new BadRequestException(msg);
      }
    }

    return { message: '엑셀 업로드가 성공적으로 완료되었습니다.' };
  }

  private mapRowToDto(row: ExcelJS.Row): any {
    return {
      code: row.getCell(1).value,
      partnerCompanyName: row.getCell(2).value,
      classificationName: row.getCell(3).value,
      brandName: row.getCell(4).value,
      name: row.getCell(5).value,
      price: row.getCell(6).value,
      expireDay: row.getCell(7).value,
      category: row.getCell(8).value,
      type: row.getCell(9).value,
      useStatus: row.getCell(10).value,
      settleMethod: row.getCell(11).value,
      settlePercent: row.getCell(12).value,
      partnerCompanyCode: row.getCell(13).value,
      imagePath: row.getCell(14).value,
      memo: row.getCell(15).value,
    };
  }

  private isValidRow(rowData: Record<string, any>): boolean {
    return Object.values(rowData).some((value) => value !== null && value !== '');
  }

  async setLike(user: ILoginUserInfo, getBody: ProductSetLikeReqDto) {
    const { productId, isLike } = getBody;

    const product = await this.productRepository.findOne({
      where: {
        id: productId,
      },
    });

    if (!product) {
      throw new BadRequestException('상품이 존재하지 않습니다.');
    }

    let productLike = await this.productLikeRepository.findOne({
      where: {
        userId: user.id,
        productId: productId,
      },
    });

    if (productLike) {
      productLike.isLike = isLike;
    } else {
      productLike = new ProductLikeEntity();
      productLike.userId = user.id;
      productLike.product = product;
      productLike.isLike = isLike;
    }
    await this.productLikeRepository.save(productLike);
  }

  async delete(getDto: ProductDeleteReqDto) {
    const { idList } = getDto;

    const productList = await this.productRepository.find({
      where: {
        id: In(idList),
      },
    });

    if (productList.length !== idList.length) {
      throw new BadRequestException('실제 존재하는 상품 개수가 일치하지 않습니다.');
    }

    await this.productRepository.softDelete({
      id: In(idList),
    });

    return;
  }

  async excelTemplateDownload() {
    // 템플릿 파일 경로
    const templatePath = join(process.cwd(), 'public', 'excel_template', '상품 등록 템플릿.xlsx');

    // 템플릿 파일 읽기
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(templatePath);

    // DB에서 데이터 조회
    const partnerCompanies = await this.partnerCompanyRepository.find({
      order: { id: 'ASC' },
    });

    const classifications = await this.classificationRepository.find({
      order: { id: 'ASC' },
    });

    const brands = await this.brandRepository.find({
      order: { id: 'ASC' },
    });

    // 협력사 시트에 데이터 작성
    const partnerSheet = workbook.getWorksheet('협력사');
    if (partnerSheet) {
      partnerCompanies.forEach((pc, index) => {
        partnerSheet.getCell(`A${index + 1}`).value = pc.businessName;
      });
    }

    // 대분류 시트에 데이터 작성
    const classificationSheet = workbook.getWorksheet('대분류');
    if (classificationSheet) {
      classifications.forEach((classification, index) => {
        classificationSheet.getCell(`A${index + 1}`).value = classification.classification;
      });
    }

    // 브랜드 시트에 데이터 작성
    const brandSheet = workbook.getWorksheet('브랜드');
    if (brandSheet) {
      brands.forEach((brand, index) => {
        brandSheet.getCell(`A${index + 1}`).value = brand.nameKorean;
      });
    }

    // 파일을 버퍼로 변환
    const fileBuffer = await workbook.xlsx.writeBuffer();

    const fileName = '상품 등록 템플릿.xlsx';

    return { fileName, fileBuffer };
  }

  async getClassificationSearchList(
    getQuery: ClassificationGetSearchListReqDto,
  ): Promise<ClassificationGetSearchListResDto> {
    const { searchText, take, page } = getQuery;

    let queryBuilder = this.classificationRepository.createQueryBuilder('classification');

    if (searchText) {
      queryBuilder = queryBuilder.andWhere('classification.classification LIKE :searchText', {
        searchText: `%${searchText}%`,
      });
    }

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.take(take).skip(skip);

    const [classificationList, totalCount] = await queryBuilder.getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const resultList: ClassificationViewDto[] = classificationList.map((classification) => {
      return {
        id: classification.id,
        classification: classification.classification,
      };
    });

    return { list: resultList, totalCount, totalPage, currentPage: page };
  }
}
