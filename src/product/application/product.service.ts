import { BadRequestException, Injectable } from '@nestjs/common';
import { ProductEntity } from '../../entity/product.entity';
import { FindOptionsWhere, In, Like, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ProductCreateReqDto,
  ProductExcelDownloadReqQueryDto,
  ProductGetDetailReqParamDto,
  ProductGetListReqQueryDto,
  ProductGetUpdateHistoryReqParamDto,
  ProductGetUpdateHistoryReqQueryDto,
  ProductSsgReqQueryDto,
  ProductUpdatePartialReqDto,
} from '../api/product.req.dto';
import { ProductViewDto } from '../api/dto/product.view.dto';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import {
  ProductGetDetailResDto,
  ProductGetListResDto,
  ProductGetSsgResDto,
  ProductGetUpdateHistoryResDto,
} from '../api/product.res.dto';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { BrandEntity } from '../../entity/brand.entity';
import { CreateCode } from '../../common/domain/create.code';
import { ProductDigitNumber, ProductPrefixCode } from '../domain/product.code';
import { ProductUpdateHistoryEntity } from '../../entity/product.update.history.entity';
import { ProductUpdateHistoryKeyName } from '../domain/product.update.history.key.name';
import { Transactional } from 'typeorm-transactional';
import { ProductHistoryViewDto } from '../api/dto/product.history.view.dto';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { join } from 'path';
import * as process from 'node:process';
import * as ExcelJS from 'exceljs';
import { ProductTypeExcelMapping, ProductUseStatusExcelMapping } from '../domain/product.excel.mapping';
import { plainToClass } from 'class-transformer';

@Injectable()
export class ProductService {
  constructor(
    @InjectRepository(ProductEntity)
    private productRepository: Repository<ProductEntity>,
    @InjectRepository(PartnerCompanyEntity)
    private partnerCompanyRepository: Repository<PartnerCompanyEntity>,
    @InjectRepository(BrandEntity)
    private brandRepository: Repository<BrandEntity>,
    @InjectRepository(ProductUpdateHistoryEntity)
    private productUpdateHistoryRepository: Repository<ProductUpdateHistoryEntity>,
  ) {}

  async getList(getQuery: ProductGetListReqQueryDto): Promise<ProductGetListResDto> {
    const { partnerCompanyId, brandId, brandName, name, useStatus, code, partnerCompanyCode, page, take } = getQuery;
    let queryBuilder = this.productRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand');

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
      return {
        id: product.id,
        createdAt: format(product.createdAt, DateFormatStr),
        type: product.type,
        code: product.code,
        partnerCompanyId: product.partnerCompanyId,
        partnerCompanyName: product.partnerCompany!.businessName,
        classification: product.classification,
        brandId: product.brandId,
        brandName: product.brand!.nameKorean,
        name: product.name,
        price: product.price,
        expireDay: product.expireDay,
        category: product.category,
        useStatus: product.useStatus,
        imagePath: product.imagePath,
        isChange,
      };
    });

    const totalPage = Math.ceil(totalCount / take);

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  async getSsg(getQuery: ProductSsgReqQueryDto): Promise<ProductGetSsgResDto> {
    const { price } = getQuery;
    const product = await this.productRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
      .where('product.price = :price', { price })
      .andWhere('partnerCompany.type = :type', { type: IPartnerCompanyType.SSG })
      .getOne();

    if (!product) {
      throw new BadRequestException('존재하지 않는 상품입니다.');
    }

    return {
      id: product.id,
      partnerCompanyId: product.partnerCompanyId,
      partnerCompanyName: product.partnerCompany!.businessName,
      classification: product.classification,
      brandId: product.brandId,
      brandName: product.brand!.nameKorean,
      name: product.name,
      price: product.price,
      expireDay: product.expireDay,
      imagePath: product.imagePath,
    };
  }

  async getDetail(getParam: ProductGetDetailReqParamDto): Promise<ProductGetDetailResDto> {
    const { id } = getParam;

    const product = await this.productRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand')
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
      classification: product.classification,
      brandId: product.brandId,
      brandName: product.brand!.nameKorean,
      name: product.name,
      price: product.price,
      expireDay: product.expireDay,
      category: product.category,

      settleMethod: product.settleMethod,
      settlePercent: product.settlePercent,
      imagePath: product.imagePath,
      type: product.type,
      couponMethod: product.couponMethod,
      memo: product.memo,
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
      classification,
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

    const prevProduct = await this.productRepository.findOne({
      where: {
        code: Like(`${ProductPrefixCode}%`),
      },
      order: { code: 'DESC' },
    });

    const prevCodeBrand = prevProduct?.code ?? null;
    const newCode = CreateCode(prevCodeBrand, ProductPrefixCode, ProductDigitNumber);

    await this.productRepository.insert({
      partnerCompanyCode,
      partnerCompanyId,
      code: newCode,
      brandId,
      name,
      price,
      expireDay,
      category,
      classification,
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

      // @ts-ignore
      const beforeValue = product[key];
      // @ts-ignore
      const afterValue = getBody[key];

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

  async excelDownload(getQuery: ProductExcelDownloadReqQueryDto) {
    const { partnerCompanyId, brandId, brandName, name, useStatus, code, partnerCompanyCode } = getQuery;

    const now = new Date();
    const nowString = format(now, 'yyyyMMdd');

    let queryBuilder = this.productRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.partnerCompany', 'partnerCompany')
      .innerJoinAndSelect('product.brand', 'brand');

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
      { header: '협력사명', key: 'partnerCompanyName', width: 20 },
      { header: '대분류', key: 'classification', width: 20 },
      { header: '브랜드명', key: 'brandName', width: 20 },
      { header: '상품명', key: 'name', width: 32 },
      { header: '가격', key: 'price', width: 32 },
      { header: '유효기간', key: 'expireDay', width: 32 },
      { header: '상품군', key: 'category', width: 40 },
      { header: '상품구분', key: 'type', width: 40 },
      { header: '상품상태', key: 'useStatus', width: 40 },
    ];

    for (const product of productList) {
      sheet.addRow({
        id: product.id,
        createdAt: format(product.createdAt, 'yyyy-MM-dd'),
        code: product.code,
        partnerCompanyName: product.partnerCompany!.businessName,
        classification: product.classification,
        brandId: product.brandId,
        brandName: product.brand!.nameKorean,
        name: product.name,
        price: product.price,
        expireDay: product.expireDay,
        type: ProductTypeExcelMapping(product.type),
        useStatus: ProductUseStatusExcelMapping(product.useStatus),
      });
    }

    const fileName = `상품_리스트_${nowString}.xlsx`;
    const filePath = join(process.cwd(), '.', 'public', fileName);

    await workbook.xlsx.writeFile(filePath);

    return { fileName, filePath };
  }

  async excelUpload(file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('not exist file');
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer);
    const worksheet = workbook.worksheets[0];

    if (!worksheet) {
      throw new BadRequestException('엑셀 파일이 비어 있습니다.');
    }

    for (let i = 2; i <= worksheet.rowCount; i++) {
      const row = worksheet.getRow(i);
      const rowData = this.mapRowToDto(row);

      if (!this.isValidRow(rowData)) {
        continue;
      }

      const productCreateReqDto = plainToClass(ProductCreateReqDto, rowData);
      await this.create(productCreateReqDto);
    }
  }

  private mapRowToDto(row: ExcelJS.Row): Record<string, any> {
    return {
      partnerCompanyCode: row.getCell(1).value,
      partnerCompanyId: row.getCell(2).value,
      brandId: row.getCell(3).value,
      name: row.getCell(4).value,
      price: row.getCell(5).value,
      expireDay: row.getCell(6).value,
      category: row.getCell(7).value,
      classification: row.getCell(8).value,
      settleMethod: row.getCell(9).value,
      settlePercent: row.getCell(10).value,
      imagePath: row.getCell(11).value,
      type: row.getCell(12).value,
      memo: row.getCell(13).value ?? null,
      useStatus: row.getCell(14).value,
    };
  }

  private isValidRow(rowData: Record<string, any>): boolean {
    return Object.values(rowData).some((value) => value !== null && value !== '');
  }
}
