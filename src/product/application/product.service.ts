import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createExportTempPath } from '../../util/file.util';
import { ProductEntity } from '../../entity/product.entity';
import { Brackets, FindOptionsWhere, In, IsNull, Like, QueryFailedError, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ClassificationCreateReqDto,
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
import { BrandDigitNumber, BrandPrefixCode } from '../../brand/domain/brand.code';
import { ProductUpdateHistoryEntity } from '../../entity/product.update.history.entity';
import { ProductUpdateHistoryKeyName } from '../domain/product.update.history.key.name';
import { Transactional } from 'typeorm-transactional';
import { ProductHistoryViewDto } from '../api/dto/product.history.view.dto';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { join, parse } from 'path';
import * as process from 'node:process';
import * as fs from 'node:fs';
import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import * as ExcelJS from 'exceljs';
import {
  ProductSettleMethodExcelMapping,
  ProductTypeExcelMapping,
  ProductUseStatusExcelMapping,
} from '../domain/product.excel.mapping';
import { IProductCategory, IProductType } from '../interface/product.type';
import { IProductUseStatus } from '../interface/product.status';
import { IUserAuthority } from '../../user/interface/user.authority';
import { UserSyncProductEventEntity } from '../../entity/user.sync.product.event.entity';
import { UserSyncProductEventMappingEntity } from '../../entity/user.sync.product.event.mapping.entity';
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
import { IFileStorage } from '../../file/interface/file.storage';
import { ProductSharedListFileEntity } from '../../entity/product.shared.list.file.entity';

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
    @InjectRepository(UserSyncProductEventMappingEntity)
    private userSyncProductEventMappingRepository: Repository<UserSyncProductEventMappingEntity>,
    @InjectRepository(ProductLikeEntity)
    private productLikeRepository: Repository<ProductLikeEntity>,
    @InjectRepository(SsgEventEntity)
    private ssgEventRepository: Repository<SsgEventEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(ProductSharedListFileEntity)
    private productSharedListFileRepository: Repository<ProductSharedListFileEntity>,
    private activityLogService: ActivityLogService,
    @Inject('IFileStorage')
    private fileStorage: IFileStorage,
  ) { }

  private static readonly SHARED_LIST_ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];

  async uploadSharedListFile(user: ILoginUserInfo, file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('업로드할 파일이 존재하지 않습니다.');
    }

    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');

    const extension = parse(file.originalname).ext.toLowerCase();
    if (!ProductService.SHARED_LIST_ALLOWED_EXTENSIONS.includes(extension)) {
      throw new BadRequestException('엑셀 또는 CSV 파일만 업로드할 수 있습니다.');
    }

    // 공유리스트는 비공개로 저장(다운로드는 백엔드 스트리밍). public-read 직접 접근 표면 제거.
    const uploadedFile = await this.fileStorage.uploadPrivateFile(file);

    const savedFile = await this.productSharedListFileRepository.save({
      userId: user.id,
      fileName: uploadedFile.originalName,
      fileUrl: uploadedFile.url,
    });

    return this.toSharedListFileResponse(savedFile);
  }

  async getSharedListFile() {
    const sharedFile = await this.findLatestSharedListFile();

    if (!sharedFile) {
      return { id: null, fileName: null, userId: null, createdAt: null };
    }

    return this.toSharedListFileResponse(sharedFile);
  }

  async downloadSharedListFile() {
    const sharedFile = await this.findLatestSharedListFile();

    if (!sharedFile) {
      throw new NotFoundException('다운로드 가능한 상품리스트 파일이 존재하지 않습니다.');
    }

    const key = this.extractStorageKey(sharedFile.fileUrl);
    // 비공개 임시 디렉터리 + UUID: public/ 노출·예측 파일명·동시 다운로드 충돌 차단(스트리밍 후 삭제됨)
    const downloadDir = join(tmpdir(), 'epopkon-shared-list');
    fs.mkdirSync(downloadDir, { recursive: true });

    const filePath = await this.fileStorage.downloadFileToLocalWithPath(
      downloadDir,
      `${randomUUID()}-${parse(sharedFile.fileName).name}`,
      key,
    );

    return { fileName: sharedFile.fileName, filePath };
  }

  private async findLatestSharedListFile(): Promise<ProductSharedListFileEntity | null> {
    return this.productSharedListFileRepository.findOne({
      where: { deletedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  private toSharedListFileResponse(file: ProductSharedListFileEntity) {
    return {
      id: file.id,
      fileName: file.fileName,
      userId: file.userId,
      createdAt: format(file.createdAt, DateFormatStr),
    };
  }

  async getTotalList(user: ILoginUserInfo, getQuery: ProductGetTotalListReqQueryDto): Promise<ProductGetListResDto> {
    const {
      searchKeyword,
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
      productCategory,
      expireDayMin,
      expireDayMax,
    } = getQuery;

    // 유효기간 필터 입력 검증: 둘 다 전송되었고 하한 > 상한이면 400
    // 주의: expireDayMin/Max 는 사용자가 직접 입력하는 값이 아니라 프론트의 유효기간 프리셋
    // (30일=29/31, 60일=59/61, 5년=1824/1826 등) 상수로 전송된다. 따라서 이 예외는 정상
    // 사용자 조작으로는 발생하지 않고 프론트 버그/API 직접 호출 시에만 도달하므로, 메시지는
    // 사용자 친화 문구가 아니라 프론트 개발자 디버깅용으로 둔다.
    if (expireDayMin !== undefined && expireDayMax !== undefined && expireDayMin > expireDayMax) {
      throw new BadRequestException('유효기간의 범위가 잘못 설정되었습니다.');
    }

    let queryBuilder = this.productRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.classification', 'classification')
      .leftJoinAndSelect('product.productLikes', 'productLikes')
      .andWhere('product.type != :ssg', { ssg: IProductType.SSG });

    if (user.authority === IUserAuthority.CORPORATE_ADMIN) {
      const events = await this.userSyncProductEventRepository.find({
        where: {
          businessUserId: user.id,
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

      // event 가 없거나 매핑된 상품이 없는 경우 빈 리스트 반환
      if (uniqueProductIds.length === 0) {
        queryBuilder = queryBuilder.andWhere('1 = 0');
      } else {
        queryBuilder = queryBuilder.andWhere('product.id IN (:...mappedProductIds)', {
          mappedProductIds: uniqueProductIds,
        });
      }
    }

    // 상품 카테고리 필터링 (모바일쿠폰 / 실물상품 탭 분리용)
    if (productCategory === IProductCategory.MOBILE_COUPON) {
      // 모바일쿠폰: GENERAL, CHOICE, DELIVERY, SELF (REAL 제외)
      queryBuilder = queryBuilder.andWhere('product.type IN (:...mobileCouponTypes)', {
        mobileCouponTypes: [IProductType.GENERAL, IProductType.CHOICE, IProductType.DELIVERY, IProductType.SELF],
      });
    } else if (productCategory === IProductCategory.REAL_PRODUCT) {
      // 실물상품: REAL만
      queryBuilder = queryBuilder.andWhere('product.type = :realType', { realType: IProductType.REAL });
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
      queryBuilder = queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('brand.nameKorean LIKE :brandName', { brandName: `%${brandName}%` }).orWhere(
            'brand.nameEnglish LIKE :brandName',
            { brandName: `%${brandName}%` },
          );
        }),
      );
    }

    // ===== 통합 검색 =====
    if (searchKeyword && searchKeyword.length >= 1) {
      queryBuilder = queryBuilder.andWhere(
        `(product.name LIKE :keyword
      OR product.code LIKE :keyword
      OR product.partnerCompanyCode LIKE :keyword)`,
        { keyword: `%${searchKeyword}%` },
      );
    }

    if (name) {
      // 띄어쓰기 무시 검색: 상품명과 검색어 모두 공백 제거 후 비교
      const searchName = name.replace(/\s/g, '');
      queryBuilder = queryBuilder.andWhere("REPLACE(product.name, ' ', '') LIKE :name", {
        name: `%${searchName}%`,
      });
    }

    if (useStatus) {
      queryBuilder = queryBuilder.andWhere('product.useStatus = :useStatus', { useStatus });
    }

    if (code) {
      queryBuilder = queryBuilder.andWhere('product.code LIKE :code', { code: `%${code}%` });
    }

    if (partnerCompanyCode) {
      queryBuilder = queryBuilder.andWhere('product.partnerCompanyCode LIKE :partnerCompanyCode', {
        partnerCompanyCode: `%${partnerCompanyCode}%`,
      });
    }

    // 유효기간(일) 범위 필터 — 한쪽만 전송 시 단방향(열린 경계), 둘 다 전송 시 BETWEEN 과 동일
    if (expireDayMin !== undefined) {
      queryBuilder = queryBuilder.andWhere('product.expireDay >= :expireDayMin', { expireDayMin });
    }

    if (expireDayMax !== undefined) {
      queryBuilder = queryBuilder.andWhere('product.expireDay <= :expireDayMax', { expireDayMax });
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
      searchKeyword,
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
      productCategory,
      expireDayMin,
      expireDayMax,
    } = getQuery;

    // 유효기간 필터 입력 검증: 둘 다 전송되었고 하한 > 상한이면 400
    // 주의: expireDayMin/Max 는 사용자가 직접 입력하는 값이 아니라 프론트의 유효기간 프리셋
    // (30일=29/31, 60일=59/61, 5년=1824/1826 등) 상수로 전송된다. 따라서 이 예외는 정상
    // 사용자 조작으로는 발생하지 않고 프론트 버그/API 직접 호출 시에만 도달하므로, 메시지는
    // 사용자 친화 문구가 아니라 프론트 개발자 디버깅용으로 둔다.
    if (expireDayMin !== undefined && expireDayMax !== undefined && expireDayMin > expireDayMax) {
      throw new BadRequestException('유효기간의 범위가 잘못 설정되었습니다.');
    }

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
      const events = await this.userSyncProductEventRepository.find({
        where: {
          businessUserId: user.id,
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

    // 상품 카테고리 필터링 (모바일쿠폰 / 실물상품 탭 분리용)
    if (productCategory === IProductCategory.MOBILE_COUPON) {
      // 모바일쿠폰: GENERAL, CHOICE, DELIVERY, SELF (REAL 제외)
      queryBuilder = queryBuilder.andWhere('product.type IN (:...mobileCouponTypes)', {
        mobileCouponTypes: [IProductType.GENERAL, IProductType.CHOICE, IProductType.DELIVERY, IProductType.SELF],
      });
    } else if (productCategory === IProductCategory.REAL_PRODUCT) {
      // 실물상품: REAL만
      queryBuilder = queryBuilder.andWhere('product.type = :realType', { realType: IProductType.REAL });
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
      queryBuilder = queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('brand.nameKorean LIKE :brandName', { brandName: `%${brandName}%` }).orWhere(
            'brand.nameEnglish LIKE :brandName',
            { brandName: `%${brandName}%` },
          );
        }),
      );
    }

    // ===== 통합 검색 =====
    if (searchKeyword && searchKeyword.length >= 1) {
      queryBuilder = queryBuilder.andWhere(
        `(product.name LIKE :keyword
      OR product.code LIKE :keyword
      OR product.partnerCompanyCode LIKE :keyword)`,
        { keyword: `%${searchKeyword}%` },
      );
    }

    if (name) {
      // 띄어쓰기 무시 검색: 상품명과 검색어 모두 공백 제거 후 비교
      const searchName = name.replace(/\s/g, '');
      queryBuilder = queryBuilder.andWhere("REPLACE(product.name, ' ', '') LIKE :name", {
        name: `%${searchName}%`,
      });
    }

    if (useStatus) {
      queryBuilder = queryBuilder.andWhere('product.useStatus = :useStatus', { useStatus });
    }

    if (code) {
      queryBuilder = queryBuilder.andWhere('product.code LIKE :code', { code: `%${code}%` });
    }

    if (partnerCompanyCode) {
      queryBuilder = queryBuilder.andWhere('product.partnerCompanyCode LIKE :partnerCompanyCode', {
        partnerCompanyCode: `%${partnerCompanyCode}%`,
      });
    }

    // 유효기간(일) 범위 필터 — 한쪽만 전송 시 단방향(열린 경계), 둘 다 전송 시 BETWEEN 과 동일
    if (expireDayMin !== undefined) {
      queryBuilder = queryBuilder.andWhere('product.expireDay >= :expireDayMin', { expireDayMin });
    }

    if (expireDayMax !== undefined) {
      queryBuilder = queryBuilder.andWhere('product.expireDay <= :expireDayMax', { expireDayMax });
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
    const product = await this.findOrCreateSsgProductByPrice(getQuery.price);
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

  /**
   * price 에 해당하는 활성 SSG 상품을 조회. 없으면 null.
   * findOrCreateSsgProductByPrice 의 fast-path 와 ER_DUP_ENTRY 멱등 재조회에서 공유한다.
   */
  private findSsgProductByPriceOrNull(price: number): Promise<ProductEntity | null> {
    return this.productRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.classification', 'classification')
      .where('product.price = :price', { price })
      .andWhere('product.type = :type ', { type: IProductType.SSG })
      .andWhere('partnerCompany.type = :type', { type: IPartnerCompanyType.SSG })
      .getOne();
  }

  /**
   * 주어진 price에 해당하는 SSG 상품을 반환. 없으면 가장 오래된 SSG 상품을 템플릿 삼아 새로 생성한다.
   * 내부 admin/외부 API 양쪽에서 sendAmount === product.price 보장을 위해 공유한다.
   */
  async findOrCreateSsgProductByPrice(price: number): Promise<ProductEntity> {
    const existing = await this.findSsgProductByPriceOrNull(price);

    if (existing) {
      return existing;
    }

    const templateProduct = await this.productRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.classification', 'classification')
      .where('product.type = :type', { type: IProductType.SSG })
      .andWhere('partnerCompany.type = :type', { type: IPartnerCompanyType.SSG })
      .orderBy('product.id', 'ASC')
      .getOne();

    if (!templateProduct) {
      throw new BadRequestException('SSG 상품 템플릿을 찾을 수 없습니다.');
    }

    const latestProduct = await this.productRepository
      .createQueryBuilder('product')
      .where('product.code LIKE :codePattern', { codePattern: 'EP%' })
      .orderBy('CAST(SUBSTRING(product.code, 3) AS UNSIGNED)', 'DESC')
      .getOne();

    let nextCodeNumber = 1;
    const codeMatch = latestProduct?.code.match(/EP(\d+)/);
    if (codeMatch) {
      nextCodeNumber = parseInt(codeMatch[1]) + 1;
    }
    const newCode = `EP${nextCodeNumber.toString().padStart(10, '0')}`;

    const currentSsgEvent = await this.ssgEventRepository
      .createQueryBuilder('ssgEvent')
      .where('ssgEvent.startAt <= :now', { now: new Date() })
      .andWhere('ssgEvent.endAt >= :now', { now: new Date() })
      .orderBy('ssgEvent.id', 'DESC')
      .getOne();

    const newProduct = new ProductEntity();
    newProduct.code = newCode;
    newProduct.partnerCompanyId = templateProduct.partnerCompanyId;
    newProduct.partnerCompanyCode = templateProduct.partnerCompanyCode;
    newProduct.brandId = templateProduct.brandId;
    newProduct.name = `신세계 상품권 ${price.toLocaleString()}원`;
    newProduct.price = price;
    newProduct.expireDay = currentSsgEvent?.couponExpiration || 60;
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

    let savedProduct: ProductEntity;
    try {
      savedProduct = await this.productRepository.save(newProduct);
    } catch (e) {
      // 동시 생성 경합(예: 생성 버튼 더블클릭): uq_product_ssg_price(price) 또는 code 유니크 위반.
      // 먼저 커밋된 row 를 재조회해 그대로 반환(멱등). price row 가 아직 안 보이면
      // (다른 가격의 EP 채번 충돌) 그대로 throw → 재시도 시 자가치유.
      if (e instanceof QueryFailedError && (e as QueryFailedError & { code?: string }).code === 'ER_DUP_ENTRY') {
        const winner = await this.findSsgProductByPriceOrNull(price);
        if (winner) {
          return winner;
        }
      }
      throw e;
    }

    const reloaded = await this.productRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.classification', 'classification')
      .where('product.id = :id', { id: savedProduct.id })
      .getOne();

    if (!reloaded) {
      throw new BadRequestException('SSG 상품 생성 후 재조회 실패');
    }

    return reloaded;
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
      classificationId: product.classificationId ?? null,
      classificationName: product.classification?.classification ?? null,
      brandId: product.brandId,
      brandName: product.brand!.nameKorean,
      name: product.name,
      price: product.price,
      expireDay: product.expireDay,
      galaxiaDuration: product.galaxiaDuration ?? null,
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
      galaxiaDuration,
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
      galaxiaDuration: galaxiaDuration ?? null,
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

    // USE → UNUSED 전환 시 고객상품관리 매핑 해제 (전시 취소 + 숨기기)
    const isDeactivating =
      product.useStatus === IProductUseStatus.UNUSED &&
      productUpdateHistoryCreateList.some(
        (h) => h.key === 'useStatus' && h.beforeValue === IProductUseStatus.USE,
      );

    if (isDeactivating) {
      await this.userSyncProductEventMappingRepository.softDelete({
        productId: id,
      });
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
      queryBuilder = queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('brand.nameKorean LIKE :brandName', { brandName: `%${brandName}%` }).orWhere(
            'brand.nameEnglish LIKE :brandName',
            { brandName: `%${brandName}%` },
          );
        }),
      );
    }

    if (name) {
      // 띄어쓰기 무시 검색: 상품명과 검색어 모두 공백 제거 후 비교
      const searchName = name.replace(/\s/g, '');
      queryBuilder = queryBuilder.andWhere("REPLACE(product.name, ' ', '') LIKE :name", {
        name: `%${searchName}%`,
      });
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
    const filePath = createExportTempPath('xlsx');

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

  // 트랜잭션 제거: 실패한 행만 건너뛰고 나머지는 처리하기 위함
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

    // 1. 대분류 시트 처리 - 새로운 대분류 자동 등록
    await this.processClassificationSheet(workbook);

    // 2. 브랜드 시트 처리 - 새로운 브랜드 자동 등록
    await this.processBrandSheet(workbook);

    console.log('[엑셀업로드] 대분류/브랜드 처리 완료, 데이터 로드 시작');

    // 협력사, 브랜드, 대분류 데이터를 미리 로드하여 맵으로 만듦
    console.log('[엑셀업로드] 협력사 로드 시작');
    const allPartnerCompanies = await this.partnerCompanyRepository.find();
    console.log(`[엑셀업로드] 협력사 로드 완료: ${allPartnerCompanies.length}건`);
    const partnerCompanyNameMap = listToMap(allPartnerCompanies, (pc) => pc.businessName);

    console.log('[엑셀업로드] 브랜드 로드 시작');
    const allBrands = await this.brandRepository.find();
    console.log(`[엑셀업로드] 브랜드 로드 완료: ${allBrands.length}건`);
    const brandNameMap = listToMap(allBrands, (brand) => brand.nameKorean);

    console.log('[엑셀업로드] 대분류 로드 시작');
    const allClassifications = await this.classificationRepository.find();
    console.log(`[엑셀업로드] 대분류 로드 완료: ${allClassifications.length}건`);
    const classificationNameMap = listToMap(allClassifications, (classification) => classification.classification);

    console.log(`[엑셀업로드] 상품코드 수집 시작 - 총 행 수: ${worksheet.actualRowCount}`);
    const codeList: string[] = [];
    const validRowIndices: number[] = []; // 실제 데이터가 있는 행 번호 저장
    let emptyRowCount = 0;
    const maxEmptyRows = 10; // 연속 빈 행 10개 이상이면 중단

    for (let i = 2; i <= worksheet.actualRowCount; i++) {
      const row = worksheet.getRow(i);
      const rowData = this.mapRowToDto(row);

      // 필수 필드(상품명, 협력사명)가 비어있으면 빈 행으로 판단
      if (!rowData.name || !rowData.partnerCompanyName) {
        emptyRowCount++;
        if (emptyRowCount >= maxEmptyRows) {
          console.log(`[엑셀업로드] 연속 빈 행 ${maxEmptyRows}개 발견, 수집 중단 (행 ${i})`);
          break;
        }
        continue;
      }

      emptyRowCount = 0; // 데이터가 있으면 카운터 리셋
      validRowIndices.push(i);
      if (rowData.code) {
        codeList.push(rowData.code);
      }
    }
    console.log(`[엑셀업로드] 상품코드 수집 완료: 유효 행 ${validRowIndices.length}건, 코드 ${codeList.length}건`);

    console.log(`[엑셀업로드] 기존 상품 조회 시작`);
    const productList = await this.productRepository.find({
      where: {
        code: In(codeList),
      },
    });
    console.log(`[엑셀업로드] 기존 상품 조회 완료: ${productList.length}건`);

    const productCodeMap = listToMap(productList, (product) => product.code);

    console.log(`[엑셀업로드] 상품 처리 시작 - 총 ${validRowIndices.length}건`);

    // 실패한 행 정보 저장
    const failedRows: { row: number; reason: string }[] = [];
    let successCount = 0;

    for (const rowIndex of validRowIndices) {
      try {
        console.log(`[엑셀업로드] 행 ${rowIndex} 처리 시작`);
        const row = worksheet.getRow(rowIndex);
        const rowData = this.mapRowToDto(row);

        // 협력사명으로 협력사 ID 조회
        const partnerCompany = partnerCompanyNameMap.get(rowData.partnerCompanyName?.trim());
        if (!partnerCompany) {
          throw new Error(`협력사명 "${rowData.partnerCompanyName}"을 찾을 수 없습니다.`);
        }

        // 브랜드명으로 브랜드 ID 조회
        const brand = brandNameMap.get(rowData.brandName?.trim());
        if (!brand) {
          throw new Error(`브랜드명 "${rowData.brandName}"을 찾을 수 없습니다.`);
        }

        // 대분류명으로 대분류 ID 조회
        const classification = classificationNameMap.get(rowData.classificationName?.trim());
        if (!classification) {
          throw new Error(`대분류 "${rowData.classificationName}"을 찾을 수 없습니다.`);
        }

        // 외부 URL 이미지인 경우 S3로 복사, 이미지 없으면 기본 이미지 사용
        let imagePath = rowData.imagePath;
        if (!imagePath || !imagePath.trim()) {
          imagePath = '/img/upload-plz.jpg';
        } else {
          const safeIp = await this.getSafeIp(imagePath);
          if (safeIp) {
            try {
              console.log(`[엑셀업로드] 행 ${rowIndex} - 외부 이미지 복사 시작: ${imagePath}`);
              const result = await this.fileStorage.copyImageFromUrl(imagePath, safeIp);
              imagePath = result.url;
              console.log(`[엑셀업로드] 행 ${rowIndex} - 외부 이미지 복사 완료: ${imagePath}`);
            } catch (e) {
              console.error(`행 ${rowIndex}: 이미지 복사 실패 - ${e.message}`);
              // 이미지 복사 실패 시 원본 URL 유지
            }
          }
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
        createDto.imagePath = imagePath;
        createDto.memo = rowData.memo;

        const validationErrors = await validate(createDto);
        if (validationErrors.length > 0) {
          console.error(JSON.stringify(validationErrors));
          throw new Error(`필수값 누락 혹은 형식 오류가 있습니다.`);
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
          updateDto.imagePath = imagePath;
          updateDto.memo = rowData.memo;

          await this.updatePartial(user, updateDto);
        } else {
          await this.create(createDto);
        }
        successCount++;
        console.log(`[엑셀업로드] 행 ${rowIndex} 처리 완료`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : '알 수 없는 오류';
        console.error(`[엑셀업로드] 행 ${rowIndex} 실패: ${reason}`);
        failedRows.push({ row: rowIndex, reason });
        // 실패해도 계속 진행
      }
    }

    console.log(`[엑셀업로드] 모든 상품 처리 완료 - 성공: ${successCount}건, 실패: ${failedRows.length}건`);

    // 결과 메시지 생성
    if (failedRows.length === 0) {
      return { message: `엑셀 업로드가 성공적으로 완료되었습니다. (${successCount}건 처리)` };
    }

    // 실패한 행 정보 포함
    const failedRowNumbers = failedRows.map((f) => f.row).join(', ');
    const failedDetails = failedRows.map((f) => `${f.row}행: ${f.reason}`).join('\n');
    console.log(`[엑셀업로드] 실패 상세:\n${failedDetails}`);

    return {
      message: `엑셀 업로드 완료. 성공: ${successCount}건, 실패: ${failedRows.length}건 (실패 행: ${failedRowNumbers})`,
      failedRows,
    };
  }

  /**
   * 엑셀 업로드 (진행 상황 콜백 포함)
   */
  // 트랜잭션 제거: 실패한 행만 건너뛰고 나머지는 처리하기 위함
  async excelUploadWithProgress(
    user: ILoginUserInfo,
    file: Express.Multer.File,
    onProgress: (stage: string, current: number, total: number, message?: string) => void,
  ) {
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

    // 1. 대분류 시트 처리 - 새로운 대분류 자동 등록
    onProgress('classification', 0, 1, '대분류 확인 중...');
    const newClassificationCount = await this.processClassificationSheetWithProgress(workbook, onProgress);

    // 2. 브랜드 시트 처리 - 새로운 브랜드 자동 등록
    onProgress('brand', 0, 1, '브랜드 확인 중...');
    const newBrandCount = await this.processBrandSheetWithProgress(workbook, onProgress);

    // 협력사, 브랜드, 대분류 데이터를 미리 로드하여 맵으로 만듦
    onProgress('prepare', 0, 1, '데이터 준비 중...');
    const allPartnerCompanies = await this.partnerCompanyRepository.find();
    const partnerCompanyNameMap = listToMap(allPartnerCompanies, (pc) => pc.businessName);

    const allBrands = await this.brandRepository.find();
    const brandNameMap = listToMap(allBrands, (brand) => brand.nameKorean);

    const allClassifications = await this.classificationRepository.find();
    const classificationNameMap = listToMap(allClassifications, (classification) => classification.classification);

    // 상품 코드 목록 수집 (연속 빈 행 체크 포함)
    const codeList: string[] = [];
    const validRowIndices: number[] = [];
    let emptyRowCount = 0;
    const maxEmptyRows = 10;

    for (let i = 2; i <= worksheet.actualRowCount; i++) {
      const row = worksheet.getRow(i);
      const rowData = this.mapRowToDto(row);

      if (!rowData.name || !rowData.partnerCompanyName) {
        emptyRowCount++;
        if (emptyRowCount >= maxEmptyRows) {
          break;
        }
        continue;
      }

      emptyRowCount = 0;
      validRowIndices.push(i);
      if (rowData.code) {
        codeList.push(rowData.code);
      }
    }

    const productList = await this.productRepository.find({
      where: { code: In(codeList) },
    });
    const productCodeMap = listToMap(productList, (product) => product.code);

    // 실패한 행 정보 저장
    const failedRows: { row: number; reason: string }[] = [];
    let successCount = 0;
    const totalProducts = validRowIndices.length;

    // 상품 등록/수정
    for (let idx = 0; idx < validRowIndices.length; idx++) {
      const rowIndex = validRowIndices[idx];
      onProgress('product', idx + 1, totalProducts, `상품 등록 중 (${idx + 1}/${totalProducts})`);

      try {
        const row = worksheet.getRow(rowIndex);
        const rowData = this.mapRowToDto(row);

        // 협력사명으로 협력사 ID 조회
        const partnerCompany = partnerCompanyNameMap.get(rowData.partnerCompanyName?.trim());
        if (!partnerCompany) {
          throw new Error(`협력사명 "${rowData.partnerCompanyName}"을 찾을 수 없습니다.`);
        }

        // 브랜드명으로 브랜드 ID 조회
        const brand = brandNameMap.get(rowData.brandName?.trim());
        if (!brand) {
          throw new Error(`브랜드명 "${rowData.brandName}"을 찾을 수 없습니다.`);
        }

        // 대분류명으로 대분류 ID 조회
        const classification = classificationNameMap.get(rowData.classificationName?.trim());
        if (!classification) {
          throw new Error(`대분류 "${rowData.classificationName}"을 찾을 수 없습니다.`);
        }

        // 외부 URL 이미지인 경우 S3로 복사, 이미지 없으면 기본 이미지 사용
        let imagePath = rowData.imagePath;
        if (!imagePath || !imagePath.trim()) {
          imagePath = '/img/upload-plz.jpg';
        } else {
          const safeIp = await this.getSafeIp(imagePath);
          if (safeIp) {
            try {
              const result = await this.fileStorage.copyImageFromUrl(imagePath, safeIp);
              imagePath = result.url;
            } catch (e) {
              console.error(`행 ${rowIndex}: 이미지 복사 실패 - ${e.message}`);
            }
          }
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
        createDto.imagePath = imagePath;
        createDto.memo = rowData.memo;

        const validationErrors = await validate(createDto);
        if (validationErrors.length > 0) {
          console.error(JSON.stringify(validationErrors));
          throw new Error(`필수값 누락 혹은 형식 오류가 있습니다.`);
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
          updateDto.imagePath = imagePath;
          updateDto.memo = rowData.memo;

          await this.updatePartial(user, updateDto);
        } else {
          await this.create(createDto);
        }
        successCount++;
      } catch (error) {
        const reason = error instanceof Error ? error.message : '알 수 없는 오류';
        console.error(`[엑셀업로드] 행 ${rowIndex} 실패: ${reason}`);
        failedRows.push({ row: rowIndex, reason });
        // 실패해도 계속 진행
      }
    }

    // 결과 메시지 생성
    if (failedRows.length === 0) {
      return { message: `엑셀 업로드가 성공적으로 완료되었습니다. (${successCount}건 처리)` };
    }

    const failedRowNumbers = failedRows.map((f) => f.row).join(', ');
    return {
      message: `엑셀 업로드 완료. 성공: ${successCount}건, 실패: ${failedRows.length}건 (실패 행: ${failedRowNumbers})`,
      failedRows,
    };
  }

  /**
   * 대분류 시트 처리 (진행 상황 포함)
   */
  private async processClassificationSheetWithProgress(
    workbook: ExcelJS.Workbook,
    onProgress: (stage: string, current: number, total: number, message?: string) => void,
  ): Promise<number> {
    const classificationSheet = workbook.getWorksheet('대분류');
    if (!classificationSheet) return 0;

    const excelClassifications: string[] = [];
    classificationSheet.eachRow((row) => {
      const cellValue = this.getCellValue(row.getCell(1));
      if (cellValue && String(cellValue).trim()) {
        excelClassifications.push(String(cellValue).trim());
      }
    });

    if (excelClassifications.length === 0) return 0;

    const existingClassifications = await this.classificationRepository.find();
    const existingNameSet = new Set(existingClassifications.map((c) => c.classification));
    const newClassifications = excelClassifications.filter((name) => !existingNameSet.has(name));

    if (newClassifications.length === 0) return 0;

    for (let i = 0; i < newClassifications.length; i++) {
      const classification = newClassifications[i];
      onProgress(
        'classification',
        i + 1,
        newClassifications.length,
        `대분류 등록 중 (${i + 1}/${newClassifications.length})`,
      );
      await this.classificationRepository.insert({ classification });
      console.log(`새로운 대분류 등록: ${classification}`);
    }

    return newClassifications.length;
  }

  /**
   * 브랜드 시트 처리 (진행 상황 포함)
   */
  private async processBrandSheetWithProgress(
    workbook: ExcelJS.Workbook,
    onProgress: (stage: string, current: number, total: number, message?: string) => void,
  ): Promise<number> {
    const brandSheet = workbook.getWorksheet('브랜드');
    if (!brandSheet) return 0;

    const excelBrands: string[] = [];
    brandSheet.eachRow((row) => {
      const cellValue = this.getCellValue(row.getCell(1));
      if (cellValue && String(cellValue).trim()) {
        excelBrands.push(String(cellValue).trim());
      }
    });

    if (excelBrands.length === 0) return 0;

    const existingBrands = await this.brandRepository.find();
    const existingNameSet = new Set(existingBrands.map((b) => b.nameKorean));
    const newBrands = excelBrands.filter((name) => !existingNameSet.has(name));

    if (newBrands.length === 0) return 0;

    for (let i = 0; i < newBrands.length; i++) {
      const nameKorean = newBrands[i];
      onProgress('brand', i + 1, newBrands.length, `브랜드 등록 중 (${i + 1}/${newBrands.length})`);

      const prevBrand = await this.brandRepository.findOne({
        where: { code: Like(`${BrandPrefixCode}%`) },
        order: { code: 'DESC' },
        withDeleted: true, // soft delete된 레코드도 포함하여 코드 중복 방지
      });
      const prevCode = prevBrand?.code ?? null;
      const newCode = CreateCode(prevCode, BrandPrefixCode, BrandDigitNumber);

      await this.brandRepository.insert({
        code: newCode,
        nameKorean,
        nameEnglish: nameKorean,
        isUsed: true,
      });
      console.log(`새로운 브랜드 등록: ${nameKorean} (${newCode})`);
    }

    return newBrands.length;
  }

  private mapRowToDto(row: ExcelJS.Row): any {
    return {
      code: this.getCellValue(row.getCell(1)),
      partnerCompanyName: this.getCellValue(row.getCell(2)),
      classificationName: this.getCellValue(row.getCell(3)),
      brandName: this.getCellValue(row.getCell(4)),
      name: this.getCellValue(row.getCell(5)),
      price: this.getCellValue(row.getCell(6)),
      expireDay: this.getCellValue(row.getCell(7)),
      category: this.getCellValue(row.getCell(8)),
      type: this.getCellValue(row.getCell(9)),
      useStatus: this.getCellValue(row.getCell(10)),
      settleMethod: this.getCellValue(row.getCell(11)),
      settlePercent: this.getCellValue(row.getCell(12)),
      partnerCompanyCode: this.getCellValue(row.getCell(13)),
      imagePath: this.getCellValue(row.getCell(14)),
      memo: this.getCellValue(row.getCell(15)),
    };
  }


  /**
   * ExcelJS 셀 값 추출 (수식 셀 처리)
   * 수식이 있는 셀은 { formula: '=A1', result: 'value' } 형태로 반환되므로 result를 추출
   */
  private getCellValue(cell: ExcelJS.Cell): any {
    let value = cell.value;
    if (value === null || value === undefined) return null;

    // 수식 셀인 경우 result 값 사용
    if (typeof value === 'object' && 'formula' in value) {
      value = (value as any).result ?? null;
      if (value === null) return null;
    }

    // 리치 텍스트인 경우 텍스트 추출
    if (value !== null && typeof value === 'object' && 'richText' in value) {
      value = (value as any).richText.map((r: any) => r.text).join('');
    }

    // 문자열인 경우 _x000D_ (캐리지 리턴) 제거
    if (typeof value === 'string') {
      value = value.replace(/_x000D_/g, '');
    }

    return value;
  }

  private async getSafeIp(url: string): Promise<string | null> {
    if (!url || typeof url !== 'string') return null;
    if (!url.startsWith('http://') && !url.startsWith('https://')) return null;
    if (url.includes('epopkon-premium.s3.amazonaws.com')) return null;

    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return null;
    }

    let address: string;
    try {
      const result = await dns.lookup(hostname);
      address = result.address;
    } catch {
      return null;
    }

    try {
      const parsed = ipaddr.parse(address);
      if (parsed.range() !== 'unicast') return null;
    } catch {
      return null;
    }

    return address;
  }

  private extractStorageKey(fileUrl: string): string {
    try {
      const parsedUrl = new URL(fileUrl);
      return decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''));
    } catch (error) {
      throw new BadRequestException('올바른 파일 경로가 아닙니다.');
    }
  }

  /**
   * 엑셀의 '대분류' 시트를 처리하여 새로운 대분류 자동 등록
   */
  private async processClassificationSheet(workbook: ExcelJS.Workbook): Promise<void> {
    const classificationSheet = workbook.getWorksheet('대분류');
    if (!classificationSheet) return;

    // 엑셀에서 대분류명 목록 추출
    const excelClassifications: string[] = [];
    classificationSheet.eachRow((row, rowNumber) => {
      const cellValue = this.getCellValue(row.getCell(1));
      if (cellValue && String(cellValue).trim()) {
        excelClassifications.push(String(cellValue).trim());
      }
    });

    if (excelClassifications.length === 0) return;

    // DB에서 기존 대분류 조회
    const existingClassifications = await this.classificationRepository.find();
    const existingNameSet = new Set(existingClassifications.map((c) => c.classification));

    // 새로운 대분류 찾기
    const newClassifications = excelClassifications.filter((name) => !existingNameSet.has(name));

    // 새로운 대분류 등록
    for (const classification of newClassifications) {
      await this.classificationRepository.insert({ classification });
      console.log(`새로운 대분류 등록: ${classification}`);
    }
  }

  /**
   * 엑셀의 '브랜드' 시트를 처리하여 새로운 브랜드 자동 등록
   */
  private async processBrandSheet(workbook: ExcelJS.Workbook): Promise<void> {
    const brandSheet = workbook.getWorksheet('브랜드');
    if (!brandSheet) return;

    // 엑셀에서 브랜드명 목록 추출
    const excelBrands: string[] = [];
    brandSheet.eachRow((row, rowNumber) => {
      const cellValue = this.getCellValue(row.getCell(1));
      if (cellValue && String(cellValue).trim()) {
        excelBrands.push(String(cellValue).trim());
      }
    });

    if (excelBrands.length === 0) return;

    // DB에서 기존 브랜드 조회
    const existingBrands = await this.brandRepository.find();
    const existingNameSet = new Set(existingBrands.map((b) => b.nameKorean));

    // 새로운 브랜드 찾기
    const newBrands = excelBrands.filter((name) => !existingNameSet.has(name));

    // 새로운 브랜드 등록
    for (const nameKorean of newBrands) {
      // 브랜드 코드 생성
      const prevBrand = await this.brandRepository.findOne({
        where: { code: Like(`${BrandPrefixCode}%`) },
        order: { code: 'DESC' },
        withDeleted: true, // soft delete된 레코드도 포함하여 코드 중복 방지
      });
      const prevCode = prevBrand?.code ?? null;
      const newCode = CreateCode(prevCode, BrandPrefixCode, BrandDigitNumber);

      await this.brandRepository.insert({
        code: newCode,
        nameKorean,
        nameEnglish: nameKorean,
        isUsed: true,
      });
      console.log(`새로운 브랜드 등록: ${nameKorean} (${newCode})`);
    }
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

    // 템플릿 파일 읽기 & DB 조회를 병렬로 실행
    const [workbook, partnerCompanies, classifications, brands] = await Promise.all([
      (async () => {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(templatePath);
        return wb;
      })(),
      // 병렬 DB 조회 - 필요한 필드만 선택
      this.partnerCompanyRepository.find({
        select: ['businessName'],
        where: { deletedAt: IsNull() },
        order: { id: 'ASC' },
      }),
      this.classificationRepository.find({
        select: ['classification'],
        where: { deletedAt: IsNull() },
        order: { id: 'ASC' },
      }),
      this.brandRepository.find({
        select: ['nameKorean'],
        where: { deletedAt: IsNull() },
        order: { id: 'ASC' },
      }),
    ]);

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

  async createClassification(getBody: ClassificationCreateReqDto) {
    const { classification } = getBody;

    // 중복 체크
    const existingClassification = await this.classificationRepository.findOne({
      where: { classification },
    });

    if (existingClassification) {
      throw new BadRequestException('이미 존재하는 대분류명입니다.');
    }

    await this.classificationRepository.insert({
      classification,
    });

    return;
  }

  async getLinkAverageExpireDay(headPersonUserId: number): Promise<{ averageExpireDay: number | null }> {
    const result = await this.userSyncProductEventRepository
      .createQueryBuilder('e')
      .select('AVG(COALESCE(p.galaxia_duration, p.expire_day))', 'averageExpireDay')
      .innerJoin('e.userSyncProductEventMappings', 'm', 'm.deletedAt IS NULL')
      .innerJoin('m.product', 'p', 'p.deletedAt IS NULL AND p.useStatus = :useStatus', {
        useStatus: IProductUseStatus.USE,
      })
      .where('e.businessUserId = :headPersonUserId', { headPersonUserId })
      .andWhere('e.status = :active', { active: IUserSyncProductStatus.ACTIVE })
      .andWhere('e.deletedAt IS NULL')
      .getRawOne<{ averageExpireDay: string | null }>();

    return {
      averageExpireDay: result?.averageExpireDay != null ? Number(result.averageExpireDay) : null,
    };
  }
}
