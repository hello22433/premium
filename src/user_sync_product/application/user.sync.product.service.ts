import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UserSyncProductEventEntity } from '../../entity/user.sync.product.event.entity';
import {
  UserSyncProductDeleteProductReqDto,
  UserSyncProductGetDetailReqParamDto,
  UserSyncProductGetListReqDto,
  UserSyncProductInsertProductReqDto,
  UserSyncProductRegisterEventReqDto,
} from '../api/user.sync.product.req.dto';
import { UserSyncProductGetDetailResDto, UserSyncProductGetListResDto } from '../api/user.sync.product.res.dto';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import { UserSyncProductEventViewDto } from '../api/dto/user.sync.product.event.view.dto';
import { UserSyncProductEventDetailDto } from '../api/dto/user.sync.product.event.detail.dto';
import { format } from 'date-fns';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { UserSyncProductEventMappingEntity } from '../../entity/user.sync.product.event.mapping.entity';
import { UserEntity } from '../../entity/user.entity';
import { ProductEntity } from '../../entity/product.entity';
import { IProductUseStatus } from '../../product/interface/product.status';

@Injectable()
export class UserSyncProductService {
  constructor(
    @InjectRepository(UserSyncProductEventEntity)
    private eventRepository: Repository<UserSyncProductEventEntity>,
    @InjectRepository(UserSyncProductEventMappingEntity)
    private eventMappingRepository: Repository<UserSyncProductEventMappingEntity>,
    @InjectRepository(ProductEntity)
    private productRepository: Repository<ProductEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) {}

  async getList(getQuery: UserSyncProductGetListReqDto): Promise<UserSyncProductGetListResDto> {
    const { take, page, name, businessUserName, startAt, endAt, code, status } = getQuery;
    const skip = (page - 1) * take;

    let queryBuilder = this.eventRepository
      .createQueryBuilder('event')
      .leftJoinAndSelect('event.userSyncProductEventMappings', 'userSyncProductEventMappings')
      .innerJoinAndSelect('event.businessUser', 'user');

    if (code) {
      queryBuilder = queryBuilder.andWhere('event.code = :code', { code });
    }

    if (businessUserName) {
      queryBuilder = queryBuilder.andWhere('user.businessName LIKE :businessName', {
        businessName: `%${businessUserName}%`,
      });
    }

    if (name) {
      queryBuilder = queryBuilder.andWhere('event.name LIKE :name', { name: `%${name}%` });
    }

    if (code) {
      queryBuilder = queryBuilder.andWhere('event.code LIKE :code', { code: `%${code}%` });
    }

    if (status) {
      queryBuilder = queryBuilder.andWhere('event.status = :status', { status });
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'event', 'createdAt', startAt, endAt);
    queryBuilder = queryBuilder.orderBy('event.id', 'DESC');

    const [eventList, totalCount] = await queryBuilder.skip(skip).take(take).getManyAndCount();
    const totalPage = Math.ceil(totalCount / take);

    const resultList: UserSyncProductEventViewDto[] = eventList.map((event) => {
      return {
        id: event.id,
        name: event.name,
        code: event.code,
        userBusinessName: event.businessUser.businessName,
        syncProductCount: event.userSyncProductEventMappings?.length ?? 0,
        status: event.status,
      };
    });

    return {
      list: resultList,
      totalPage,
      totalCount,
      currentPage: page,
    };
  }

  async getDetail(getParam: UserSyncProductGetDetailReqParamDto): Promise<UserSyncProductGetDetailResDto> {
    const { id } = getParam;

    const event = await this.eventRepository.findOne({
      where: {
        id,
      },
      relations: [
        'userSyncProductEventMappings',
        'userSyncProductEventMappings.product',
        'userSyncProductEventMappings.product.brand',
      ],
    });

    if (!event) {
      throw new BadRequestException('존재하지 않는 연동 상품 이벤트 id 입니다.');
    }

    const result: UserSyncProductEventDetailDto[] = [];

    if (event.userSyncProductEventMappings != null && event.userSyncProductEventMappings.length > 0) {
      for (const mapping of event.userSyncProductEventMappings) {
        const product = mapping.product;
        if (!product) continue;

        result.push({
          id: mapping.id,
          registerAt: format(mapping.product.createdAt, DateFormatStr),
          code: product.code,
          classification: product.classification || null,
          brandName: product.brand?.nameKorean || '',
          name: product.name,
          price: product.price,
          expireDay: product.expireDay,
          category: product.category || null,
          useStatus: product.useStatus,
        });
      }
    }

    return {
      list: result,
    };
  }

  async registerEvent(getBody: UserSyncProductRegisterEventReqDto): Promise<void> {
    const { userId, name, code, userPersonName, status, phone, email } = getBody;

    // const adminUser = await this.userRepository.findOne({
    //   where: {
    //     id: adminUserId,
    //     authority: IUserAuthority.SUPER_ADMIN,
    //   },
    // });
    //
    // if (!adminUser) {
    //   throw new BadRequestException('존재하지 않는 최고 관리자입니다.');
    // }

    const businessUser = await this.userRepository.findOne({
      where: {
        id: userId,
        // authority: IUserAuthority.CORPORATE_ADMIN,
      },
    });

    if (!businessUser) {
      throw new BadRequestException('존재하지 않는 고객사 유저입니다.');
    }

    await this.eventRepository.insert({
      name,
      status,
      phone,
      email,
      code,
      personName: userPersonName,
      // adminUserId: adminUserId,
      businessUserId: userId,
    });
  }

  async insertProduct(getBody: UserSyncProductInsertProductReqDto): Promise<void> {
    const { eventId, productIdList } = getBody;

    // 1. 이벤트 확인
    const event = await this.eventRepository.findOne({ where: { id: eventId } });
    if (!event) {
      throw new BadRequestException('존재하지 않는 이벤트 입니다.');
    }

    // 2. 상품 조회
    const products = await this.productRepository.find({
      where: {
        id: In(productIdList),
        useStatus: IProductUseStatus.USE,
      },
    });
    const productIds = products.map((product) => product.id);

    if (productIds.length === 0) {
      throw new BadRequestException('상품이 존재하지 않습니다.');
    }

    // 3. 이미 등록된 상품 필터링
    const existingMappingProducts = await this.eventMappingRepository.find({
      where: {
        userSyncProductEventId: eventId,
        productId: In(productIds),
      },
    });

    const existingProductIds = existingMappingProducts.map((mapping) => mapping.productId);
    const newProductIds = productIds.filter((id) => !existingProductIds.includes(id));

    if (newProductIds.length === 0) {
      throw new BadRequestException('상품이 이미 추가되어있습니다.');
    }

    const insertMapping = newProductIds.map((productId) => {
      return this.eventMappingRepository.create({
        userSyncProductEventId: eventId,
        productId,
      });
    });

    await this.eventMappingRepository.save(insertMapping);
  }

  async deleteProduct(getBody: UserSyncProductDeleteProductReqDto): Promise<void> {
    const { idList } = getBody;

    const existingMappings = await this.eventMappingRepository.find({
      where: { id: In(idList) },
      select: ['id'],
    });

    const existingIds = existingMappings.map((m) => m.id);
    const missingIds = idList.filter((id) => !existingIds.includes(id));

    if (missingIds.length > 0) {
      throw new BadRequestException('존재하지 않는 매핑 id가 포함되어 있습니다');
    }

    await this.eventMappingRepository.softDelete({
      id: In(idList),
    });
  }
}
