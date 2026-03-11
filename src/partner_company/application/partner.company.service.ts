import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { BadRequestException, Injectable } from '@nestjs/common';
import { FindOptionsWhere, Like, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import {
  PartnerCompanyCreateReqDto,
  PartnerCompanyGetDetailReqParamDto,
  PartnerCompanyGetListReqQueryDto,
  PartnerCompanyGetSearchListReqQueryDto,
  PartnerCompanyUpdateReqDto,
} from '../api/partner.company.req.dto';
import {
  PartnerCompanyGetDetailResDto,
  PartnerCompanyGetListResDto,
  PartnerCompanyGetSearchListResDto,
  PartnerCompanyGetSelectListResDto,
  PartnerCompanyGetValidityListResDto,
} from '../api/partner.company.res.dto';
import { PartnerCompanySearchViewDto } from '../api/dto/partner.company.search.view.dto';
import { PartnerCompanyViewDto } from '../api/dto/partner.company.view.dto';
import { PartnerCompanyValidityViewDto } from '../api/dto/partner.company.validity.view.dto';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { CreateCode } from '../../common/domain/create.code';
import { PartnerCompanyDigitNumber, PartnerCompanyPrefixCode } from '../domain/partner.company.code';
import { IPartnerCompanyStatus } from '../interface/partner.company.status';
import { IPartnerCompanyType } from '../interface/partner.company.type';

@Injectable()
export class PartnerCompanyService {
  constructor(
    @InjectRepository(PartnerCompanyEntity)
    private partnerCompanyRepository: Repository<PartnerCompanyEntity>,
  ) { }

  async getSelectList(): Promise<PartnerCompanyGetSelectListResDto> {
    const partnerCompanyList = await this.partnerCompanyRepository.find({});

    const resultList: PartnerCompanySearchViewDto[] = partnerCompanyList.map((partnerCompany) => {
      return {
        id: partnerCompany.id,
        code: partnerCompany.code,
        businessName: partnerCompany.businessName,
        personName: partnerCompany.personName,
        status: IPartnerCompanyStatus.ACTIVE,
      };
    });

    return { list: resultList };
  }

  async getValidityList(): Promise<PartnerCompanyGetValidityListResDto> {
    const partnerCompanyList = await this.partnerCompanyRepository.find({
      select: ['businessName', 'validityStartsNextDay'],
    });

    const resultList: PartnerCompanyValidityViewDto[] = partnerCompanyList.map((partnerCompany) => {
      return {
        businessName: partnerCompany.businessName,
        validityStartsNextDay: partnerCompany.validityStartsNextDay,
      };
    });

    return { list: resultList };
  }

  async getSearchList(getQuery: PartnerCompanyGetSearchListReqQueryDto): Promise<PartnerCompanyGetSearchListResDto> {
    const { businessName, take, page } = getQuery;

    let whereCondition: FindOptionsWhere<PartnerCompanyEntity> = {};

    if (businessName) {
      whereCondition = { ...whereCondition, businessName: Like(`%${businessName}%`) };
    }

    const skip = (page - 1) * take;
    const partnerCompanyList = await this.partnerCompanyRepository.find({
      where: whereCondition,
      take: take,
      skip,
    });

    const totalCount = await this.partnerCompanyRepository.count({ where: whereCondition });
    const totalPage = Math.ceil(totalCount / take);

    const resultList: PartnerCompanySearchViewDto[] = partnerCompanyList.map((partnerCompany) => {
      return {
        id: partnerCompany.id,
        code: partnerCompany.code,
        businessName: partnerCompany.businessName,
        personName: partnerCompany.personName,
        status: IPartnerCompanyStatus.ACTIVE,
      };
    });

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  async getList(getQuery: PartnerCompanyGetListReqQueryDto): Promise<PartnerCompanyGetListResDto> {
    const {
      startCreatedAt,
      endCreatedAt,
      settleCondition,
      searchType,
      searchKeyword,
      email,
      businessName,
      personName,
      personPhoneNumber,
      take,
      page,
    } = getQuery;

    let queryBuilder = this.partnerCompanyRepository.createQueryBuilder('partnerCompany');

    // 1. 개별 필드 검색 (프론트엔드에서 특정 필드로 꽂아줄 때)
    if (email) {
      queryBuilder = queryBuilder.andWhere('partnerCompany.personEmail LIKE :email', { email: `%${email}%` });
    }
    if (businessName) {
      queryBuilder = queryBuilder.andWhere('partnerCompany.businessName LIKE :businessName', {
        businessName: `%${businessName}%`,
      });
    }
    if (personName) {
      queryBuilder = queryBuilder.andWhere('partnerCompany.personName LIKE :personName', {
        personName: `%${personName}%`,
      });
    }
    if (personPhoneNumber) {
      queryBuilder = queryBuilder.andWhere('partnerCompany.personPhoneNumber LIKE :personPhoneNumber', {
        personPhoneNumber: `%${personPhoneNumber}%`,
      });
    }

    // 2. 통합 검색 (searchType + searchKeyword 조합으로 올 때)
    if (searchKeyword && searchKeyword.length >= 1) {
      switch (searchType) {
        case 'email':
          queryBuilder = queryBuilder.andWhere('partnerCompany.personEmail LIKE :keyword', {
            keyword: `%${searchKeyword}%`,
          });
          break;
        case 'businessName':
          queryBuilder = queryBuilder.andWhere('partnerCompany.businessName LIKE :keyword', {
            keyword: `%${searchKeyword}%`,
          });
          break;
        case 'personName':
          queryBuilder = queryBuilder.andWhere('partnerCompany.personName LIKE :keyword', {
            keyword: `%${searchKeyword}%`,
          });
          break;
        case 'personPhoneNumber':
          queryBuilder = queryBuilder.andWhere('partnerCompany.personPhoneNumber LIKE :keyword', {
            keyword: `%${searchKeyword}%`,
          });
          break;
        default: // 'ALL' 이거나 검색 타입이 없을 때 전방위 검색
          queryBuilder = queryBuilder.andWhere(
            `(partnerCompany.personEmail LIKE :keyword
              OR partnerCompany.businessName LIKE :keyword
              OR partnerCompany.personName LIKE :keyword
              OR partnerCompany.personPhoneNumber LIKE :keyword)`,
            { keyword: `%${searchKeyword}%` },
          );
          break;
      }
    }

    if (settleCondition) {
      queryBuilder = queryBuilder.andWhere('partnerCompany.settleCondition = :settleCondition', { settleCondition });
    }

    if (startCreatedAt && endCreatedAt) {
      queryBuilder = queryBuilder.andWhere('partnerCompany.createdAt >= :startCreatedAt', {
        startCreatedAt: new Date(startCreatedAt),
      });
      queryBuilder = queryBuilder.andWhere('partnerCompany.createdAt <= :endCreatedAt', {
        endCreatedAt: new Date(endCreatedAt),
      });
    }

    if (startCreatedAt && !endCreatedAt) {
      queryBuilder = queryBuilder.andWhere('partnerCompany.createdAt >= :startCreatedAt', {
        startCreatedAt: new Date(startCreatedAt),
      });
    }

    if (!startCreatedAt && endCreatedAt) {
      queryBuilder = queryBuilder.andWhere('partnerCompany.createdAt <= :endCreatedAt', {
        endCreatedAt: new Date(endCreatedAt),
      });
    }

    queryBuilder = queryBuilder.orderBy('partnerCompany.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.take(take).skip(skip);
    const [partnerCompanyList, totalCount] = await queryBuilder.getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const resultList: PartnerCompanyViewDto[] = partnerCompanyList.map((partnerCompany) => {
      return {
        id: partnerCompany.id,
        createdAt: format(partnerCompany.createdAt, DateFormatStr),
        code: partnerCompany.code,
        businessName: partnerCompany.businessName,
        personName: partnerCompany.personName,
        personPhoneNumber: partnerCompany.personPhoneNumber,
        personEmail: partnerCompany.personEmail,
        settleCondition: partnerCompany.settleCondition,
        settleMethod: partnerCompany.settleMethod,
        settleDay: partnerCompany.settleDay,
        maximumLimit: partnerCompany.maximumLimit,
        status: partnerCompany.status,
      };
    });

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  async getDetail(getParam: PartnerCompanyGetDetailReqParamDto): Promise<PartnerCompanyGetDetailResDto> {
    const { id } = getParam;

    const partnerCompany = await this.partnerCompanyRepository.findOne({
      where: {
        id: id,
      },
    });

    if (!partnerCompany) {
      throw new BadRequestException('협력사가 존재하지 않습니다.');
    }

    return {
      id: partnerCompany.id,
      code: partnerCompany.code,
      corporateNumber: partnerCompany.corporateNumber,
      businessNumber: partnerCompany.businessNumber,
      businessName: partnerCompany.businessName,
      businessAddress: partnerCompany.businessAddress,
      businessPhoneNumber: partnerCompany.businessPhoneNumber,
      personName: partnerCompany.personName,
      personPhoneNumber: partnerCompany.personPhoneNumber,
      personEmail: partnerCompany.personEmail,
      settleCondition: partnerCompany.settleCondition,
      settleDay: partnerCompany.settleDay,
      settleMethod: partnerCompany.settleMethod,
      maximumLimit: partnerCompany.maximumLimit,
      bankName: partnerCompany.bankName,
      bankNumber: partnerCompany.bankNumber,
      status: partnerCompany.status,
      createdAt: format(partnerCompany.createdAt, DateFormatStr),
      validityStartsNextDay: partnerCompany.validityStartsNextDay,
    };
  }

  async create(getBody: PartnerCompanyCreateReqDto) {
    const {
      corporateNumber,
      businessPhoneNumber,
      businessName,
      businessNumber,
      businessAddress,
      personName,
      personPhoneNumber,
      personEmail,
      settleCondition,
      settleMethod,
      maximumLimit,
      bankNumber,
      bankName,
      settleDay,
      type,
      validityStartsNextDay,
    } = getBody;

    const prevPartnerCompany = await this.partnerCompanyRepository.findOne({
      where: {
        code: Like(`${PartnerCompanyPrefixCode}%`),
      },
      order: { code: 'DESC' },
    });

    const prevCodeBrand = prevPartnerCompany?.code ?? null;
    const newCode = CreateCode(prevCodeBrand, PartnerCompanyPrefixCode, PartnerCompanyDigitNumber);

    await this.partnerCompanyRepository.insert({
      code: newCode,
      corporateNumber,
      businessPhoneNumber,
      businessName,
      businessNumber,
      businessAddress,
      personName,
      personPhoneNumber,
      personEmail,
      settleCondition,
      settleMethod,
      maximumLimit,
      bankNumber,
      bankName,
      settleDay,
      type: type ?? null,
      validityStartsNextDay: validityStartsNextDay ?? true,
    });

    return;
  }

  async update(getBody: PartnerCompanyUpdateReqDto) {
    const {
      id,
      corporateNumber,
      businessPhoneNumber,
      businessName,
      businessNumber,
      businessAddress,
      personName,
      personPhoneNumber,
      personEmail,
      settleCondition,
      settleMethod,
      maximumLimit,
      bankNumber,
      bankName,
      settleDay,
      type,
      validityStartsNextDay,
    } = getBody;

    const partnerCompany = await this.partnerCompanyRepository.findOne({
      where: {
        id,
      },
    });

    if (!partnerCompany) {
      throw new BadRequestException('협력사가 존재하지 않습니다.');
    }

    partnerCompany.corporateNumber = corporateNumber;
    partnerCompany.businessPhoneNumber = businessPhoneNumber;
    partnerCompany.businessName = businessName;
    partnerCompany.businessNumber = businessNumber;
    partnerCompany.businessAddress = businessAddress;
    partnerCompany.personName = personName;
    partnerCompany.personPhoneNumber = personPhoneNumber;
    partnerCompany.personEmail = personEmail;
    partnerCompany.settleCondition = settleCondition;
    partnerCompany.settleMethod = settleMethod;
    partnerCompany.maximumLimit = maximumLimit;
    partnerCompany.bankNumber = bankNumber;
    partnerCompany.bankName = bankName;
    partnerCompany.settleDay = settleDay;
    // type은 유효한 enum 값이 제공된 경우에만 업데이트 (빈 문자열, null, undefined 무시)
    if (type && Object.values(IPartnerCompanyType).includes(type)) {
      partnerCompany.type = type;
    }
    partnerCompany.validityStartsNextDay = validityStartsNextDay ?? partnerCompany.validityStartsNextDay;

    await this.partnerCompanyRepository.save(partnerCompany);

    return;
  }
}
