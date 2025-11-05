import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UserSyncProductEventEntity } from '../../entity/user.sync.product.event.entity';
import {
  UserSyncProductDeleteProductReqDto,
  UserSyncProductGetDetailReqParamDto,
  UserSyncProductGetHeadPersonListReqQueryDto,
  UserSyncProductGetListReqDto,
  UserSyncProductInsertProductReqDto,
  UserSyncProductRegisterEventReqDto,
  UserSyncProductSetHeadPersonReqDto,
  UserSyncProductUpdateStatusReqDto,
} from '../api/user.sync.product.req.dto';
import {
  UserSyncProductGetDetailResDto,
  UserSyncProductGetHeadPersonListResDto,
  UserSyncProductGetListResDto,
  UserSyncProductGetPersonsByBusinessResDto,
} from '../api/user.sync.product.res.dto';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import { UserSyncProductEventViewDto } from '../api/dto/user.sync.product.event.view.dto';
import { UserSyncProductEventDetailDto } from '../api/dto/user.sync.product.event.detail.dto';
import { UserSyncProductPersonInfoDto } from '../api/dto/user.sync.product.person.info.dto';
import { format } from 'date-fns';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { UserSyncProductEventMappingEntity } from '../../entity/user.sync.product.event.mapping.entity';
import { UserEntity } from '../../entity/user.entity';
import { ProductEntity } from '../../entity/product.entity';
import { IProductUseStatus } from '../../product/interface/product.status';
import { IUserSyncProductStatus } from '../interface/user.sync.product.status';
import { UserSyncProductPersonProductViewDto } from '../api/dto/user.sync.product.person.product.view.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';

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
    } else {
      queryBuilder = queryBuilder.andWhere('event.status = :status', { status: IUserSyncProductStatus.ACTIVE });
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'event', 'createdAt', startAt, endAt);
    queryBuilder = queryBuilder.orderBy('event.id', 'DESC');

    const [eventList, totalCount] = await queryBuilder.skip(skip).take(take).getManyAndCount();
    const totalPage = Math.ceil(totalCount / take);

    const resultList: UserSyncProductEventViewDto[] = eventList.map((event) => {
      return {
        id: event.id,
        createdAt: format(event.createdAt, DateFormatStr),
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

  async updateStatus(getBody: UserSyncProductUpdateStatusReqDto): Promise<boolean> {
    const { id, status } = getBody;

    const event = await this.eventRepository.findOne({ where: { id } });
    if (!event) {
      throw new BadRequestException('존재하지 않는 이벤트 입니다.');
    }

    event.status = status;

    await this.eventRepository.save(event);

    return true;
  }

  async getDetail(getParam: UserSyncProductGetDetailReqParamDto): Promise<UserSyncProductGetDetailResDto> {
    const { id } = getParam;

    const event = await this.eventRepository
      .createQueryBuilder('event')
      .innerJoinAndSelect('event.businessUser', 'businessUser')
      .leftJoinAndSelect('event.userSyncProductEventMappings', 'userSyncProductEventMappings')
      .leftJoinAndSelect('userSyncProductEventMappings.product', 'product')
      .leftJoinAndSelect('product.brand', 'brand')
      .where('event.id = :id', { id })
      .getOne();

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
          businessUserName: event.businessUser.businessName,
          businessPersonName: event.businessUser.personName,
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
      userId: event.businessUser.id,
      businessUserName: event.businessUser.businessName,
      businessPersonName: event.businessUser.personName,
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

    const existEvent = await this.eventRepository.count({
      where: {
        businessUserId: userId,
      },
    });

    if (existEvent) {
      throw new BadRequestException('해당 계정의 이벤트가 이미 존재합니다.');
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

  async getPersonsByBusinessNumber(userId: number): Promise<UserSyncProductGetPersonsByBusinessResDto> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new BadRequestException('존재하지 않는 유저입니다.');
    }

    const normalizedBusinessNumber = user.businessNumber.replace(/-/g, '');

    const users = await this.userRepository
      .createQueryBuilder('user')
      .where('REPLACE(user.businessNumber, "-", "") = :normalizedBusinessNumber', {
        normalizedBusinessNumber,
      })
      .orderBy('user.isHeadPerson', 'DESC')
      .addOrderBy('user.id', 'ASC')
      .getMany();

    if (users.length === 0) {
      throw new BadRequestException('해당 사업자 번호로 등록된 담당자가 없습니다.');
    }

    const persons: UserSyncProductPersonInfoDto[] = users.map((user) => ({
      userId: user.id,
      personName: user.personName,
      personEmail: user.personEmail,
      personPhoneNumber: user.personPhoneNumber,
      isHeadPerson: user.isHeadPerson,
    }));

    return {
      businessNumber: users[0].businessNumber,
      businessName: users[0].businessName,
      personCount: users.length,
      persons,
    };
  }

  async getHeadPersonList(
    getQuery: UserSyncProductGetHeadPersonListReqQueryDto,
  ): Promise<UserSyncProductGetHeadPersonListResDto> {
    const { userId, take, page, keyword, personName } = getQuery;
    const skip = (page - 1) * take;

    const oneUser = await this.userRepository.findOneOrFail({
      where: {
        id: userId,
      },
    });

    let queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .where('user.businessNumber = :businessNumber', { businessNumber: oneUser.businessNumber });

    if (keyword) {
      queryBuilder = queryBuilder.andWhere('(user.businessName LIKE :keyword OR user.personEmail LIKE :keyword)', {
        keyword: `%${keyword}%`,
      });
    }

    if (personName) {
      queryBuilder = queryBuilder.andWhere('user.personName LIKE :personName', { personName: `%${personName}%` });
    }

    const [headPersonUsers, totalCount] = await queryBuilder
      .orderBy('user.id', 'ASC')
      .skip(skip)
      .take(take)
      .getManyAndCount();

    const list: UserSyncProductPersonProductViewDto[] = [];

    for (const user of headPersonUsers) {
      let queryBuilder = this.eventRepository
        .createQueryBuilder('event')
        .innerJoinAndSelect('event.businessUser', 'businessUser')
        .leftJoinAndSelect('event.userSyncProductEventMappings', 'mappings')
        .leftJoin('mappings.product', 'product')
        .leftJoin('product.brand', 'brand')
        .where('event.businessUserId = :userId', { userId: user.id })
        .andWhere('event.status = :status', { status: IUserSyncProductStatus.ACTIVE });

      const events = await queryBuilder
        .select(['event.id', 'mappings.id', 'mappings.productId', 'product.id', 'product.brandId', 'brand.id'])
        .getMany();

      let productCount = 0;
      const brandIds = new Set<number>();

      for (const event of events) {
        if (event.userSyncProductEventMappings) {
          for (const mapping of event.userSyncProductEventMappings) {
            productCount++;
            if (mapping.product?.brandId) {
              brandIds.add(mapping.product.brandId);
            }
          }
        }
      }

      list.push({
        headPersonEmail: user.personEmail,
        headPersonUserId: user.id,
        businessName: user.businessName,
        headPersonName: user.personName,
        brandCount: brandIds.size,
        productCount: productCount,
      });
    }

    const totalPage = Math.ceil(totalCount / take);

    return {
      list,
      totalCount,
      totalPage,
      currentPage: page,
    };
  }

  async setHeadPerson(user: ILoginUserInfo, getBody: UserSyncProductSetHeadPersonReqDto): Promise<boolean> {
    const { userId } = getBody;

    // body user 정보 확인
    const findUser = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!findUser) {
      throw new BadRequestException('존재하지 않는 유저입니다.');
    }

    // 같은 사업자 번호를 가진 모든 담당자 조회
    const normalizedBusinessNumber = findUser.businessNumber.replace(/-/g, '');

    const users = await this.userRepository
      .createQueryBuilder('user')
      .where('REPLACE(user.businessNumber, "-", "") = :normalizedBusinessNumber', {
        normalizedBusinessNumber,
      })
      .getMany();

    if (users.length === 0) {
      throw new BadRequestException('해당 사업자 번호로 등록된 담당자가 없습니다.');
    }

    // 선택한 담당자가 해당 사업자 번호에 속하는지 확인
    const targetUser = users.find((user) => user.id === userId);
    if (!targetUser) {
      throw new BadRequestException('해당 담당자는 이 사업자 번호(회사)에 속하지 않습니다.');
    }

    for (const user of users) {
      user.isHeadPerson = false;
    }
    targetUser.isHeadPerson = true;

    await this.userRepository.save(users);

    return true;
  }
}
