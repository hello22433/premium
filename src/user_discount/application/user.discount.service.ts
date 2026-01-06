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

  /**
   * 할인 그룹 키 생성 (같은 그룹을 식별하기 위한 키)
   */
  private getDiscountGroupKey(discount: UserDiscountEntity): string {
    return `${discount.category}-${discount.method}-${discount.primaryCategory || ''}-${discount.group || ''}`;
  }

  async getList(getQuery: UserDiscountGetListReqDto): Promise<UserDiscountGetListResDto> {
    const { userId, partnerCompanyId, page, take } = getQuery;

    if (userId && partnerCompanyId) {
      throw new BadRequestException('조회할 id는 한 개만 입력 가능합니다.');
    }

    let queryBuilder = this.userDiscountRepository.createQueryBuilder('discount');

    if (userId) {
      queryBuilder = queryBuilder.andWhere('discount.userId = :userId', { userId });
    }

    if (partnerCompanyId) {
      queryBuilder = queryBuilder.andWhere('discount.partnerCompanyId = :partnerCompanyId', { partnerCompanyId });
    }

    // 그룹별로 정렬하여 조회 (같은 그룹이 연속되도록)
    queryBuilder = queryBuilder
      .orderBy('discount.category', 'ASC')
      .addOrderBy('discount.method', 'ASC')
      .addOrderBy('discount.primaryCategory', 'ASC')
      .addOrderBy('discount.group', 'ASC')
      .addOrderBy('CAST(discount.range AS UNSIGNED)', 'ASC');

    // 전체 데이터 조회
    const allDiscounts = await queryBuilder.getMany();
    const totalCount = allDiscounts.length;

    if (totalCount === 0) {
      return { list: [], totalCount: 0, totalPage: 0, currentPage: page };
    }

    // 그룹별로 묶기
    const groups: UserDiscountEntity[][] = [];
    let currentGroup: UserDiscountEntity[] = [];
    let currentGroupKey = '';

    for (const discount of allDiscounts) {
      const groupKey = this.getDiscountGroupKey(discount);

      if (groupKey !== currentGroupKey) {
        if (currentGroup.length > 0) {
          groups.push(currentGroup);
        }
        currentGroup = [discount];
        currentGroupKey = groupKey;
      } else {
        currentGroup.push(discount);
      }
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    // 각 페이지에 어떤 그룹들이 포함되는지 계산 (그룹이 페이지 경계에서 잘리지 않도록)
    const pageGroupRanges: { startGroupIndex: number; endGroupIndex: number }[] = [];
    let currentPageStart = 0;
    let currentPageItemCount = 0;

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      // 현재 페이지에 그룹을 추가할 수 있는지 확인
      if (currentPageItemCount > 0 && currentPageItemCount + group.length > take) {
        // 현재 페이지 범위 저장
        pageGroupRanges.push({
          startGroupIndex: currentPageStart,
          endGroupIndex: i - 1,
        });
        // 새 페이지 시작
        currentPageStart = i;
        currentPageItemCount = group.length;
      } else {
        currentPageItemCount += group.length;
      }
    }
    // 마지막 페이지 범위 저장
    if (currentPageStart < groups.length) {
      pageGroupRanges.push({
        startGroupIndex: currentPageStart,
        endGroupIndex: groups.length - 1,
      });
    }

    const totalPage = pageGroupRanges.length;

    // 요청된 페이지의 그룹들 추출
    const pageItems: UserDiscountEntity[] = [];
    if (page <= totalPage) {
      const range = pageGroupRanges[page - 1];
      for (let i = range.startGroupIndex; i <= range.endGroupIndex; i++) {
        pageItems.push(...groups[i]);
      }
    }

    const resultList: UserDiscountViewDto[] = pageItems.map((discount) => {
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
      // 1. 비교조건 방향 혼합 검사 (이하/미만 vs 이상/초과) - 구간 설정 유연성을 위해 제거
      /*
      const existingIsUpperBound = isUpperBound(existing.compareCondition);
      const existingIsLowerBound = isLowerBound(existing.compareCondition);

      if ((newIsUpperBound && existingIsLowerBound) || (newIsLowerBound && existingIsUpperBound)) {
        const targetName = category === IUserDiscountCategory.CATEGORY ? `상품군 ${group}` : `대분류 ${primaryCategory}`;
        throw new BadRequestException(
          `${targetName}에 이미 다른 방향의 비교조건이 등록되어 있습니다. ` +
            `이하/미만과 이상/초과를 혼합하여 사용할 수 없습니다.`,
        );
      }
      */

      // 2. 같은 구간 값 중복 검사 (값과 조건이 모두 같을 때만 차단)
      if (existing.range === range && existing.compareCondition === compareCondition) {
        const targetName = category === IUserDiscountCategory.CATEGORY ? `상품군 ${group}` : `대분류 ${primaryCategory}`;
        throw new BadRequestException(`${targetName}에 이미 같은 구간(${range}원) 및 조건이 등록되어 있습니다.`);
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
