import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import {
  UserDiscountCreateReqDto,
  UserDiscountDeleteReqDto,
  UserDiscountGetListReqDto,
} from '../api/user.discount.req.dto';
import { UserDiscountGetListResDto } from '../api/user.discount.res.dto';
import { UserDiscountViewDto } from '../api/dto/user.discount.view.dto';
import { UserEntity } from '../../entity/user.entity';
import { IUserDiscountMethod } from '../interface/user.discount.method';
import { IUserDiscountCategory } from '../interface/user.discount.category';
import { ICompareCondition } from '../interface/compare.condition';

@Injectable()
export class UserDiscountService {
  constructor(
    @InjectRepository(UserDiscountEntity)
    private userDiscountRepository: Repository<UserDiscountEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) {}

  async getList(getQuery: UserDiscountGetListReqDto): Promise<UserDiscountGetListResDto> {
    const { userId, partnerCompanyId, page, take } = getQuery;

    if (userId && partnerCompanyId) {
      throw new BadRequestException('조회할 id는 한 개만 입력 가능합니다.');
    }

    const skip = (page - 1) * take;
    let queryBuilder = this.userDiscountRepository.createQueryBuilder('discount');

    if (userId) {
      queryBuilder = queryBuilder.andWhere('discount.userId = :userId', { userId });
    }

    if (partnerCompanyId) {
      queryBuilder = queryBuilder.andWhere('discount.partnerCompanyId = :partnerCompanyId', { partnerCompanyId });
    }

    const [discountList, totalCount] = await queryBuilder.skip(skip).take(take).getManyAndCount();

    const resultList: UserDiscountViewDto[] = discountList.map((discount) => {
      return {
        id: discount.id,
        userId: discount.userId ?? null,
        partnerCompanyId: discount.partnerCompanyId ?? null,
        method: discount.method,
        group: discount.group ?? null,
        category: discount.category ?? null,
        primaryCategory: discount.primaryCategory ?? null,
        range: discount.range ?? null,
        compareCondition: discount.compareCondition,
        priceAdjustment: discount.priceAdjustment,
        pricePercent: discount.pricePercent,
      };
    });

    const totalPage = Math.ceil(totalCount / take);

    return { list: resultList, totalCount, totalPage, currentPage: page };
  }

  async create(getBody: UserDiscountCreateReqDto) {
    const {
      userId,
      partnerCompanyId,
      compareCondition,
      range,
      priceAdjustment,
      pricePercent,
      method,
      primaryCategory,
      category,
      group,
    } = getBody;

    const user = await this.userRepository.findOneBy({ id: userId });

    if (!user) {
      throw new BadRequestException(`User does not exist`);
    }

    // 구간(SECTION) 방식일 때 구간 충돌 검증
    if (method === IUserDiscountMethod.SECTION) {
      await this.validateSectionDiscount({
        userId,
        partnerCompanyId,
        category,
        group: group ?? undefined,
        primaryCategory: primaryCategory ?? undefined,
        compareCondition,
        range: range ?? undefined,
      });
    }

    await this.userDiscountRepository.insert({
      userId,
      partnerCompanyId,
      method,
      group,
      category,
      primaryCategory,
      range,
      priceAdjustment,
      compareCondition,
      pricePercent,
    });
  }

  /**
   * 구간(SECTION) 할인 옵션 등록 시 구간 충돌 검증
   * - 같은 상품군/대분류에서 비교조건 방향이 혼합되면 안 됨
   * - 이하/미만 (상한 기준) vs 이상/초과 (하한 기준) 혼합 불가
   * - 같은 구간 값에 대한 중복 등록 불가
   */
  private async validateSectionDiscount(params: {
    userId?: number;
    partnerCompanyId?: number;
    category: IUserDiscountCategory;
    group?: string;
    primaryCategory?: string;
    compareCondition: ICompareCondition;
    range?: string;
  }) {
    const { userId, partnerCompanyId, category, group, primaryCategory, compareCondition, range } = params;

    // 같은 유저/협력사의 기존 구간 할인 옵션 조회
    let queryBuilder = this.userDiscountRepository
      .createQueryBuilder('discount')
      .where('discount.method = :method', { method: IUserDiscountMethod.SECTION })
      .andWhere('discount.category = :category', { category });

    if (userId) {
      queryBuilder = queryBuilder.andWhere('discount.userId = :userId', { userId });
    }
    if (partnerCompanyId) {
      queryBuilder = queryBuilder.andWhere('discount.partnerCompanyId = :partnerCompanyId', { partnerCompanyId });
    }

    // 상품군/대분류 매칭
    if (category === IUserDiscountCategory.CATEGORY && group) {
      queryBuilder = queryBuilder.andWhere('discount.group = :group', { group });
    } else if (category === IUserDiscountCategory.CLASSIFICATION && primaryCategory) {
      queryBuilder = queryBuilder.andWhere('discount.primaryCategory = :primaryCategory', { primaryCategory });
    }

    const existingDiscounts = await queryBuilder.getMany();

    if (existingDiscounts.length === 0) {
      return; // 기존 할인 옵션이 없으면 검증 통과
    }

    // 비교조건 방향 분류
    const isUpperBound = (condition: ICompareCondition) =>
      condition === ICompareCondition.LESS || condition === ICompareCondition.LESS_THAN;
    const isLowerBound = (condition: ICompareCondition) =>
      condition === ICompareCondition.MORE || condition === ICompareCondition.MORE_THAN;

    const newIsUpperBound = isUpperBound(compareCondition);
    const newIsLowerBound = isLowerBound(compareCondition);

    for (const existing of existingDiscounts) {
      const existingIsUpperBound = isUpperBound(existing.compareCondition);
      const existingIsLowerBound = isLowerBound(existing.compareCondition);

      // 1. 비교조건 방향 혼합 검사 (이하/미만 vs 이상/초과)
      if ((newIsUpperBound && existingIsLowerBound) || (newIsLowerBound && existingIsUpperBound)) {
        const targetName = category === IUserDiscountCategory.CATEGORY ? `상품군 ${group}` : `대분류 ${primaryCategory}`;
        throw new BadRequestException(
          `${targetName}에 이미 다른 방향의 비교조건이 등록되어 있습니다. ` +
            `이하/미만과 이상/초과를 혼합하여 사용할 수 없습니다.`,
        );
      }

      // 2. 같은 구간 값 중복 검사
      if (existing.range === range) {
        const targetName = category === IUserDiscountCategory.CATEGORY ? `상품군 ${group}` : `대분류 ${primaryCategory}`;
        throw new BadRequestException(`${targetName}에 이미 같은 구간(${range}원)이 등록되어 있습니다.`);
      }
    }
  }

  async delete(getBody: UserDiscountDeleteReqDto) {
    const { id } = getBody;

    const discount = await this.userDiscountRepository.findOne({
      where: { id },
    });

    if (!discount) {
      throw new BadRequestException(`discount option not exist`);
    }

    await this.userDiscountRepository.softDelete(id);
  }
}
