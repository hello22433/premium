import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserDiscountEntity } from '../../entity/user.discount.entity';
import { UserDiscountCreateReqDto, UserDiscountGetListReqDto } from '../api/user.discount.req.dto';
import { UserDiscountGetListResDto } from '../api/user.discount.res.dto';
import { UserDiscountViewDto } from '../api/dto/user.discount.view.dto';
import { UserEntity } from '../../entity/user.entity';

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
}
