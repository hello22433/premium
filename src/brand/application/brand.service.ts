import { BadRequestException, Injectable } from '@nestjs/common';
import { BrandEntity } from '../../entity/brand.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Like, Repository } from 'typeorm';
import {
  BrandCreateReqDto,
  BrandGetDetailReqParamDto,
  BrandGetSearchListReqDto,
  BrandUpdateReqDto,
} from '../api/brand.req.dto';
import { BrandGetDetailResDto, BrandGetSearchListResDto, BrandGetSelectListResDto } from '../api/brand.res.dto';
import { BrandViewDto } from '../api/dto/brand.view.dto';
import { BrandDigitNumber, BrandPrefixCode } from '../domain/brand.code';
import { CreateCode } from '../../common/domain/create.code';

@Injectable()
export class BrandService {
  constructor(
    @InjectRepository(BrandEntity)
    private brandRepository: Repository<BrandEntity>,
  ) {}

  async getSelectList(): Promise<BrandGetSelectListResDto> {
    const queryBuilder = this.brandRepository.createQueryBuilder('brand');

    // 브랜드명 기준 오름차순 정렬 (숫자 -> 영어 -> 한글)
    const brandList = await queryBuilder.orderBy('brand.nameKorean', 'ASC').getMany();

    const resultList: BrandViewDto[] = brandList.map((brand) => {
      return {
        id: brand.id,
        code: brand.code,
        nameKorean: brand.nameKorean,
        nameEnglish: brand.nameEnglish,
        isUsed: brand.isUsed,
      };
    });

    return { list: resultList };
  }

  async getSearchList(getQuery: BrandGetSearchListReqDto): Promise<BrandGetSearchListResDto> {
    const { searchText, take, page } = getQuery;

    let queryBuilder = this.brandRepository.createQueryBuilder('brand');

    if (searchText) {
      queryBuilder = queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('brand.nameKorean LIKE :searchText', { searchText: `%${searchText}%` }).orWhere(
            'brand.nameEnglish LIKE :searchText',
            { searchText: `%${searchText}%` },
          );
        }),
      );
    }

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.take(take).skip(skip);

    const [brandList, totalCount] = await queryBuilder.getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const resultList: BrandViewDto[] = brandList.map((brand) => {
      return {
        id: brand.id,
        code: brand.code,
        nameKorean: brand.nameKorean,
        nameEnglish: brand.nameEnglish,
        isUsed: brand.isUsed,
      };
    });

    return { list: resultList, totalCount, totalPage, currentPage: page };
  }

  async getDetail(getParam: BrandGetDetailReqParamDto): Promise<BrandGetDetailResDto> {
    const { id } = getParam;
    const brand = await this.brandRepository.findOne({
      where: {
        id,
      },
    });

    if (!brand) {
      throw new BadRequestException('브랜드가 존재하지 않습니다.');
    }

    return {
      id: brand.id,
      code: brand.code,
      nameKorean: brand.nameKorean,
      nameEnglish: brand.nameEnglish,
      isUsed: brand.isUsed,
    };
  }

  async create(getBody: BrandCreateReqDto) {
    const { nameKorean, nameEnglish, isUsed } = getBody;

    const prevBrand = await this.brandRepository.findOne({
      where: {
        code: Like(`${BrandPrefixCode}%`),
      },
      order: { code: 'DESC' },
      withDeleted: true, // soft delete된 레코드도 포함하여 코드 중복 방지
    });

    const prevCodeBrand = prevBrand?.code ?? null;
    const newCode = CreateCode(prevCodeBrand, BrandPrefixCode, BrandDigitNumber);

    await this.brandRepository.insert({
      code: newCode,
      nameKorean,
      nameEnglish,
      isUsed,
    });

    return;
  }

  async update(getBody: BrandUpdateReqDto) {
    const { id, nameKorean, nameEnglish, isUsed } = getBody;

    const brand = await this.brandRepository.findOne({ where: { id } });

    if (!brand) {
      throw new BadRequestException('브랜드가 존재하지 않습니다.');
    }

    brand.nameKorean = nameKorean;
    brand.nameEnglish = nameEnglish;
    brand.isUsed = isUsed;

    await this.brandRepository.save(brand);

    return;
  }
}
