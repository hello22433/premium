import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import {
  UserDiscountCreateReqDto,
  UserDiscountDeleteReqDto,
  UserDiscountGetListReqDto,
} from '../api/user.discount.req.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { IUserAuthority } from '../../user/interface/user.authority';
import { UserDiscountGetListResDto } from '../api/user.discount.res.dto';
import { UserDiscountViewDto } from '../api/dto/user.discount.view.dto';
import { UserEntity } from '../../entity/user.entity';
import { ClassificationEntity } from '../../entity/classification.entity';
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
    @InjectRepository(ClassificationEntity)
    private classificationRepository: Repository<ClassificationEntity>,
  ) {}

  /**
   * 할인 그룹 키 생성 (같은 그룹을 식별하기 위한 키)
   */
  private getDiscountGroupKey(discount: UserDiscountEntity): string {
    return `${discount.category}-${discount.method}-${discount.primaryCategory || ''}-${discount.group || ''}-${discount.classificationId || ''}`;
  }

  async getList(getQuery: UserDiscountGetListReqDto): Promise<UserDiscountGetListResDto> {
    const { userId, partnerCompanyId, page, take } = getQuery;

    if (userId && partnerCompanyId) {
      throw new BadRequestException('조회할 id는 한 개만 입력 가능합니다.');
    }

    let queryBuilder = this.userDiscountRepository
      .createQueryBuilder('discount')
      .leftJoinAndSelect('discount.classification', 'classification');

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
      .addOrderBy('discount.classificationId', 'ASC')
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
        classificationId: discount.classificationId ?? null,
        classificationName: discount.classification?.classification ?? null,
        primaryCategory: discount.primaryCategory ?? null,
        range: discount.range ?? null,
        compareCondition: discount.compareCondition,
        priceAdjustment: discount.priceAdjustment,
        pricePercent: discount.pricePercent,
      };
    });

    return { list: resultList, totalCount, totalPage, currentPage: page };
  }

  async create(loginUser: ILoginUserInfo, getBody: UserDiscountCreateReqDto) {
    if (loginUser.authority === IUserAuthority.CORPORATE_ADMIN) {
      throw new ForbiddenException('할인 옵션 등록 권한이 없습니다.');
    }

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
      classificationId,
    } = getBody;

    if (!Number.isFinite(pricePercent)) {
      throw new BadRequestException('할인율은 숫자여야 합니다.');
    }
    if (pricePercent < 0 || pricePercent > 100) {
      throw new BadRequestException('할인율은 0~100 사이여야 합니다.');
    }

    const user = await this.userRepository.findOneBy({ id: userId });

    if (!user) {
      throw new BadRequestException(`User does not exist`);
    }

    // category별 필수값 검증
    if (category === IUserDiscountCategory.PRODUCT_GROUP && !group) {
      throw new BadRequestException('상품군 할인 시 상품군(group)은 필수입니다.');
    }
    if (category === IUserDiscountCategory.CATEGORY) {
      if (!classificationId) {
        throw new BadRequestException('카테고리 할인 시 카테고리(classificationId)는 필수입니다.');
      }
      const classification = await this.classificationRepository.findOneBy({ id: classificationId });
      if (!classification) {
        throw new BadRequestException('해당 카테고리가 존재하지 않습니다.');
      }
    }
    if (category === IUserDiscountCategory.BRAND && !primaryCategory) {
      throw new BadRequestException('브랜드 할인 시 브랜드(primaryCategory)는 필수입니다.');
    }

    const baseInsertData = {
      userId,
      partnerCompanyId,
      method,
      group,
      category,
      primaryCategory,
      classificationId: classificationId ?? null,
      priceAdjustment,
      pricePercent,
    };

    if (method === IUserDiscountMethod.BULK) {
      await this.validateBulkDiscount({
        userId,
        partnerCompanyId,
        category,
        group: group ?? undefined,
        primaryCategory: primaryCategory ?? undefined,
        classificationId: classificationId ?? undefined,
      });

      await this.userDiscountRepository.insert({
        ...baseInsertData,
        range: null,
        compareCondition: ICompareCondition.ALL,
      });
    } else {
      await this.validateSectionDiscount({
        userId,
        partnerCompanyId,
        category,
        group: group ?? undefined,
        primaryCategory: primaryCategory ?? undefined,
        classificationId: classificationId ?? undefined,
        compareCondition: compareCondition!,
        range: range ?? undefined,
      });

      await this.userDiscountRepository.insert({
        ...baseInsertData,
        range,
        compareCondition,
      });
    }
  }

  /**
   * 일괄(BULK) 할인 옵션 등록 시 검증
   * - 같은 분류에 이미 일괄 할인이 등록되어 있으면 차단
   * - 같은 분류에 구간 할인이 등록되어 있으면 차단 (일괄/구간 동시 등록 불가)
   */
  private async validateBulkDiscount(params: {
    userId?: number;
    partnerCompanyId?: number;
    category: IUserDiscountCategory;
    group?: string;
    primaryCategory?: string;
    classificationId?: number;
  }) {
    const { userId, partnerCompanyId, category, group, primaryCategory, classificationId } = params;

    const targetName = this.getTargetName(category, group, primaryCategory, classificationId);

    let queryBuilder = this.userDiscountRepository
      .createQueryBuilder('discount')
      .andWhere('discount.category = :category', { category });

    if (userId) {
      queryBuilder = queryBuilder.andWhere('discount.userId = :userId', { userId });
    }
    if (partnerCompanyId) {
      queryBuilder = queryBuilder.andWhere('discount.partnerCompanyId = :partnerCompanyId', { partnerCompanyId });
    }

    queryBuilder = this.addCategoryFilter(queryBuilder, category, group, primaryCategory, classificationId);

    const existing = await queryBuilder.getOne();

    if (existing) {
      if (existing.method === IUserDiscountMethod.BULK) {
        throw new BadRequestException(`${targetName}에 이미 일괄 할인이 등록되어 있습니다.`);
      }
      if (existing.method === IUserDiscountMethod.SECTION) {
        throw new BadRequestException(
          `${targetName}에 이미 구간 할인이 등록되어 있습니다. 삭제 후 등록해주세요.`,
        );
      }
    }
  }

  /**
   * 구간(SECTION) 할인 옵션 등록 시 검증
   * - 같은 분류에 일괄 할인이 등록되어 있으면 차단 (일괄/구간 동시 등록 불가)
   * - 같은 구간 값에 대한 중복 등록 불가
   */
  private async validateSectionDiscount(params: {
    userId?: number;
    partnerCompanyId?: number;
    category: IUserDiscountCategory;
    group?: string;
    primaryCategory?: string;
    classificationId?: number;
    compareCondition: ICompareCondition;
    range?: string;
  }) {
    const { userId, partnerCompanyId, category, group, primaryCategory, classificationId, compareCondition, range } =
      params;

    const targetName = this.getTargetName(category, group, primaryCategory, classificationId);

    let queryBuilder = this.userDiscountRepository
      .createQueryBuilder('discount')
      .andWhere('discount.category = :category', { category });

    if (userId) {
      queryBuilder = queryBuilder.andWhere('discount.userId = :userId', { userId });
    }
    if (partnerCompanyId) {
      queryBuilder = queryBuilder.andWhere('discount.partnerCompanyId = :partnerCompanyId', { partnerCompanyId });
    }

    queryBuilder = this.addCategoryFilter(queryBuilder, category, group, primaryCategory, classificationId);

    const existingDiscounts = await queryBuilder.getMany();

    if (existingDiscounts.length === 0) {
      return;
    }

    const existingBulk = existingDiscounts.find((d) => d.method === IUserDiscountMethod.BULK);
    if (existingBulk) {
      throw new BadRequestException(
        `${targetName}에 이미 일괄 할인이 등록되어 있습니다. 삭제 후 등록해주세요.`,
      );
    }

    for (const existing of existingDiscounts) {
      if (existing.range === range && existing.compareCondition === compareCondition) {
        throw new BadRequestException(`${targetName}에 이미 같은 구간(${range}원) 및 조건이 등록되어 있습니다.`);
      }
    }
  }

  private getTargetName(
    category: IUserDiscountCategory,
    group?: string,
    primaryCategory?: string,
    classificationId?: number,
  ): string {
    switch (category) {
      case IUserDiscountCategory.PRODUCT_GROUP:
        return `상품군 ${group}`;
      case IUserDiscountCategory.CATEGORY:
        return `카테고리 ${classificationId}`;
      case IUserDiscountCategory.BRAND:
        return `브랜드 ${primaryCategory}`;
    }
  }

  private addCategoryFilter(
    queryBuilder: SelectQueryBuilder<UserDiscountEntity>,
    category: IUserDiscountCategory,
    group?: string,
    primaryCategory?: string,
    classificationId?: number,
  ) {
    switch (category) {
      case IUserDiscountCategory.PRODUCT_GROUP:
        if (group) queryBuilder = queryBuilder.andWhere('discount.group = :group', { group });
        break;
      case IUserDiscountCategory.CATEGORY:
        if (classificationId)
          queryBuilder = queryBuilder.andWhere('discount.classificationId = :classificationId', { classificationId });
        break;
      case IUserDiscountCategory.BRAND:
        if (primaryCategory)
          queryBuilder = queryBuilder.andWhere('discount.primaryCategory = :primaryCategory', { primaryCategory });
        break;
    }
    return queryBuilder;
  }

  async delete(loginUser: ILoginUserInfo, getBody: UserDiscountDeleteReqDto) {
    if (loginUser.authority === IUserAuthority.CORPORATE_ADMIN) {
      throw new ForbiddenException('할인 옵션 삭제 권한이 없습니다.');
    }

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
