import { BadRequestException, Injectable } from '@nestjs/common';
import { In, Like, Repository } from 'typeorm';
import { ProductChoicePrefixCode, ProductDigitNumber } from '../../product/domain/product.code';
import { CreateCode } from '../../common/domain/create.code';
import { InjectRepository } from '@nestjs/typeorm';
import { ProductEntity } from '../../entity/product.entity';
import {
  ProductChoiceCreateReqDto,
  ProductChoiceDeleteReqDto,
  ProductChoiceGetDetailReqParamDto,
  ProductChoiceGetListReqQueryDto,
  ProductChoiceGetProductListReqQueryDto,
  ProductChoiceUpdateReqDto,
} from '../api/product.choice.req.dto';
import { IProductType } from '../../product/interface/product.type';
import { IProductUseStatus } from '../../product/interface/product.status';
import { hasUnusedComponent, isAutoUnusedByHistory, resolveChoiceUseStatus } from '../domain/choice.use.status';
import { ProductChoiceMappingEntity } from '../../entity/product.choice.mapping.entity';
import { ProductUpdateHistoryEntity } from '../../entity/product.update.history.entity';
import {
  ProductUpdateHistoryKeyName,
  ProductUseStatusAutoHistoryKey,
} from '../../product/domain/product.update.history.key.name';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { IsolationLevel, Transactional } from 'typeorm-transactional';
import { format } from 'date-fns';
import { DateDateFormatStr } from '../../common/domain/date.format.str';
import { ProductChoiceProductViewDto } from '../api/dto/product.choice.product.view.dto';
import {
  ProductChoiceDeleteCheckResDto,
  ProductChoiceGetDetailResDto,
  ProductChoiceGetListResDto,
  ProductChoiceGetProductListResDto,
} from '../api/product.choice.res.dto';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';
import { ProductChoiceViewDto } from '../api/dto/product.choice.view.dto';
import {
  choiceProductBrandId,
  choiceProductCategory,
  choiceProductClassificationId,
  choiceProductCouponMethod,
  choiceProductExpireDay,
  choiceProductPartnerCompanyCode,
  choiceProductPartnerCompanyId,
  choiceProductSettleMethod,
  choiceProductSettlePercent,
} from '../../const';

@Injectable()
export class ProductChoiceService {
  constructor(
    @InjectRepository(ProductEntity)
    private productRepository: Repository<ProductEntity>,
    @InjectRepository(ProductChoiceMappingEntity)
    private productChoiceMappingRepository: Repository<ProductChoiceMappingEntity>,
    @InjectRepository(ProductUpdateHistoryEntity)
    private productUpdateHistoryRepository: Repository<ProductUpdateHistoryEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
  ) {}

  async getList(getQuery: ProductChoiceGetListReqQueryDto): Promise<ProductChoiceGetListResDto> {
    const { createdStartAt, createdEndAt, name, code, expireDay, price, page, take } = getQuery;
    // 구성상품은 left join 으로 가져온다.
    // inner join 이면 삭제된 구성상품이 조인에서 빠져 남은 상품만으로 정상으로 보이거나,
    // 구성상품이 전부 삭제된 초이스쿠폰 행 자체가 목록에서 사라진다.
    // 매핑은 남기고 상품만 undefined 로 넘겨야 hasUnusedComponent 가 비정상으로 판정한다.
    let queryBuilder = this.productRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.productChoiceMappings', 'productChoiceMappings')
      .leftJoinAndSelect('productChoiceMappings.product', 'subProduct')
      .andWhere('product.type = :type', { type: IProductType.CHOICE });

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'product', 'createdAt', createdStartAt, createdEndAt);

    if (code) {
      queryBuilder = queryBuilder.andWhere('product.code LIKE :code', { code: `%${code}%` });
    }

    if (name) {
      queryBuilder = queryBuilder.andWhere('product.name LIKE :name', { name: `%${name}%` });
    }

    if (price) {
      queryBuilder = queryBuilder.andWhere('product.price = :price', {
        price: price,
      });
    }

    if (expireDay) {
      queryBuilder = queryBuilder.andWhere('product.expireDay = :expireDay', {
        expireDay: expireDay,
      });
    }

    queryBuilder = queryBuilder.orderBy('product.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.skip(skip).take(take);

    const [productList, totalCount] = await queryBuilder.getManyAndCount();

    const resultList = productList.map((product): ProductChoiceViewDto => {
      const hasUnusedProduct = hasUnusedComponent(
        product.productChoiceMappings.map((mapping) => mapping.product?.useStatus),
      );

      return {
        id: product.id,
        createdDate: format(product.createdAt, DateDateFormatStr),
        code: product.code,
        name: product.name,
        productComposition: product.productChoiceMappings[0]?.product?.name ?? '',
        productCount: product.productChoiceMappings.length,
        usagePeriod: '2024-01-01~2024-12-31', // TODO:
        useStatus: product.useStatus,
        registrationStatus: hasUnusedProduct ? '비정상' : '정상',
        hasUnusedProduct,
      };
    });

    const totalPage = Math.ceil(totalCount / take);

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  async getDetail(getParam: ProductChoiceGetDetailReqParamDto): Promise<ProductChoiceGetDetailResDto> {
    const { id } = getParam;

    const productChoice = await this.productRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.productChoiceMappings', 'productChoiceMappings')
      .innerJoinAndSelect('productChoiceMappings.product', 'subProduct')
      .innerJoinAndSelect('subProduct.brand', 'brand')
      .andWhere('product.type = :type', { type: IProductType.CHOICE })
      .andWhere('product.id = :id', { id })
      .getOne();

    if (!productChoice) {
      throw new BadRequestException('존재하지 않는 초이스쿠폰입니다.');
    }

    const productList = productChoice.productChoiceMappings.map((productMapping): ProductChoiceProductViewDto => {
      return {
        id: productMapping.product.id,
        createdDate: format(productMapping.product.createdAt, DateDateFormatStr),
        code: productMapping.product.code,
        classification: productMapping.product.classification?.classification ?? '',
        brandId: productMapping.product.brandId,
        brandName: productMapping.product.brand!.nameKorean,
        name: productMapping.product.name,
        price: productMapping.product.price,
        expireDay: productMapping.product.expireDay,
        category: productMapping.product.category,
        useStatus: productMapping.product.useStatus,
      };
    });

    return {
      id: productChoice.id,
      code: productChoice.code,
      name: productChoice.name,
      price: productChoice.price,
      imagePath: productChoice.imagePath,
      useStatus: productChoice.useStatus,
      productList: productList,
    };
  }

  async getProductList(getQuery: ProductChoiceGetProductListReqQueryDto): Promise<ProductChoiceGetProductListResDto> {
    const { brandId, category, name, useStatus, code, expireDay, price, page, take } = getQuery;
    let queryBuilder = this.productRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.brand', 'brand')
      .andWhere('product.type IN (:...types)', { types: [IProductType.SELF, IProductType.GENERAL] });

    if (brandId) {
      queryBuilder = queryBuilder.andWhere('product.brandId = :brandId', { brandId });
    }

    if (category) {
      queryBuilder = queryBuilder.andWhere('product.category LIKE :category', { category: `%${category}%` });
    }

    if (useStatus) {
      queryBuilder = queryBuilder.andWhere('product.useStatus = :useStatus', { useStatus });
    }

    if (code) {
      queryBuilder = queryBuilder.andWhere('product.code LIKE :code', { code: `%${code}%` });
    }

    if (name) {
      queryBuilder = queryBuilder.andWhere('product.name LIKE :name', { name: `%${name}%` });
    }

    if (price) {
      queryBuilder = queryBuilder.andWhere('product.price = :price', {
        price: price,
      });
    }

    if (expireDay) {
      queryBuilder = queryBuilder.andWhere('product.expireDay = :expireDay', {
        expireDay: expireDay,
      });
    }

    queryBuilder = queryBuilder.orderBy('product.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.skip(skip).take(take);

    const [productList, totalCount] = await queryBuilder.getManyAndCount();

    const resultList = productList.map((product): ProductChoiceProductViewDto => {
      return {
        id: product.id,
        createdDate: format(product.createdAt, DateDateFormatStr),
        code: product.code,
        classification: product.classification?.classification ?? '',
        brandId: product.brandId,
        brandName: product.brand!.nameKorean,
        name: product.name,
        price: product.price,
        expireDay: product.expireDay,
        category: product.category,
        useStatus: product.useStatus,
      };
    });

    const totalPage = Math.ceil(totalCount / take);

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  // READ COMMITTED 로 둬야 락을 잡은 뒤 읽은 구성상품 상태가 다른 트랜잭션의 최신 커밋을 반영한다.
  // MySQL 기본 REPEATABLE READ 면 트랜잭션 시작 시점 스냅샷을 봐서 옛 상태로 판단할 수 있다.
  @Transactional({ isolationLevel: IsolationLevel.READ_COMMITTED })
  async create(user: ILoginUserInfo, getBody: ProductChoiceCreateReqDto) {
    const { name, productIdList, useStatus } = getBody;
    let { imagePath } = getBody;

    const products = await this.findComponentsWithLock(productIdList);

    // 락 조회는 중복 id 를 한 건으로 합치므로 길이 비교가 중복까지 걸러낸다.
    // 중복 요청을 통과시키면 같은 구성상품 매핑이 여러 건 저장된다.
    if (products.length !== productIdList.length) {
      throw new BadRequestException(`존재하지 않거나 삭제된 상품이 있습니다.`);
    }

    const initialPrice = products[0].price;
    imagePath = imagePath ? imagePath : products[0].imagePath;

    if (!products.every((product) => product.price === initialPrice)) {
      throw new BadRequestException(`가격이 다른 상품이 포함 되어 있습니다.`);
    }

    const prevProduct = await this.productRepository.findOne({
      where: {
        code: Like(`${ProductChoicePrefixCode}%`),
      },
      order: { code: 'DESC' },
      withDeleted: true,
    });

    const prevCodeBrand = prevProduct?.code ?? null;
    const newCode = CreateCode(prevCodeBrand, ProductChoicePrefixCode, ProductDigitNumber);

    const insertedProduct = this.productRepository.create({
      type: IProductType.CHOICE,
      code: newCode,
      name,
      imagePath: imagePath!,
      partnerCompanyCode: choiceProductPartnerCompanyCode,
      partnerCompanyId: choiceProductPartnerCompanyId,
      brandId: choiceProductBrandId,
      price: initialPrice,
      expireDay: choiceProductExpireDay,
      category: choiceProductCategory,
      classificationId: choiceProductClassificationId,
      settlePercent: choiceProductSettlePercent,
      settleMethod: choiceProductSettleMethod,
      couponMethod: choiceProductCouponMethod,
      useStatus: this.applyComponentUseStatus(useStatus, products),
    });

    const newChoiceProduct = await this.productRepository.save(insertedProduct);

    const newChoiceProductId = newChoiceProduct.id;

    // 사용상태를 이력에 남긴다.
    // 관리자가 USE 를 요청했는데 구성상품 때문에 UNUSED 로 보정된 경우는 자동 강등이다.
    // 이때 수동 이력으로 남기면 이후 구성상품이 회복돼도 자동 복구 대상에서 빠진다.
    await this.saveUseStatusHistory(user, newChoiceProductId, null, newChoiceProduct.useStatus, useStatus);

    const productChoiceMappings = productIdList.map((productId) => {
      return this.productChoiceMappingRepository.create({
        choiceProductId: newChoiceProductId,
        productId: productId,
      });
    });

    await this.productChoiceMappingRepository.insert(productChoiceMappings);

    return;
  }

  @Transactional({ isolationLevel: IsolationLevel.READ_COMMITTED })
  async update(user: ILoginUserInfo, getBody: ProductChoiceUpdateReqDto) {
    const { id, name, productIdList, useStatus } = getBody;
    let { imagePath } = getBody;

    // 초이스쿠폰 -> 구성상품 순서로 잠근다.
    // ProductService.syncChoiceUseStatus 도 같은 순서로 잠그므로 두 경로가 엇갈려도 데드락이 나지 않는다.
    const product = await this.productRepository.findOne({
      where: { id: id, type: IProductType.CHOICE },
      lock: { mode: 'pessimistic_write' },
    });

    if (!product) {
      throw new BadRequestException('존재하지 않는 상품입니다.');
    }

    const products = await this.findComponentsWithLock(productIdList);

    // 락 조회는 중복 id 를 한 건으로 합치므로 길이 비교가 중복까지 걸러낸다.
    // 중복 요청을 통과시키면 같은 구성상품 매핑이 여러 건 저장된다.
    if (products.length !== productIdList.length) {
      throw new BadRequestException(`존재하지 않거나 삭제된 상품이 있습니다.`);
    }

    const initialPrice = products[0].price;
    imagePath = imagePath ? imagePath : products[0].imagePath;
    if (!products.every((product) => product.price === initialPrice)) {
      throw new BadRequestException(`가격이 다른 상품이 포함 되어 있습니다.`);
    }

    const nextUseStatus = this.applyComponentUseStatus(useStatus, products);

    await this.productRepository.update(id, {
      type: IProductType.CHOICE,
      name,
      imagePath: imagePath!,
      price: initialPrice,
      useStatus: nextUseStatus,
    });

    // 사용상태가 바뀌면 이력을 남긴다.
    // 관리자가 USE 를 요청했는데 구성상품 때문에 UNUSED 로 보정됐다면 자동 강등으로 남겨야
    // 이후 구성상품이 회복될 때 자동 복구 대상이 된다.
    //
    // 값이 그대로여도 자동 강등 상태를 관리자가 같은 값으로 확정한 경우에는 이력을 남긴다.
    // 마지막 이력이 자동 key 로 남아 있으면 구성상품이 회복될 때 자동으로 USE 가 되어
    // 관리자의 미사용 의도가 무시되기 때문이다. 수동 이력으로 그 연결을 끊는다.
    //
    // 이 판별은 위에서 초이스쿠폰 행에 잡은 쓰기 락 안에서 수행한다.
    // syncChoiceUseStatus 도 같은 행 락을 거치므로 두 경로가 직렬화되어
    // 판별과 이력 기록 사이에 자동 강등이 끼어들지 못한다.
    const isManualRequest = nextUseStatus === useStatus;
    const needsManualOverride = product.useStatus === nextUseStatus && isManualRequest && (await this.isAutoUnused(id));

    if (product.useStatus !== nextUseStatus || needsManualOverride) {
      await this.saveUseStatusHistory(user, id, product.useStatus, nextUseStatus, useStatus);
    }

    await this.productChoiceMappingRepository.softDelete({ choiceProductId: id });

    const productChoiceMappings = productIdList.map((productId) => {
      return this.productChoiceMappingRepository.create({
        choiceProductId: id,
        productId: productId,
      });
    });

    await this.productChoiceMappingRepository.insert(productChoiceMappings);

    return;
  }

  async checkDelete(getBody: ProductChoiceDeleteReqDto): Promise<ProductChoiceDeleteCheckResDto> {
    const { idList } = getBody;
    await this.assertAllChoiceProductsExist(idList);

    const [waitCount, pendingCustomerCount] = await Promise.all([
      this.countWaitDeliveries(idList),
      this.countPendingCustomerDeliveries(idList),
    ]);

    return { waitCount, pendingCustomerCount };
  }

  @Transactional()
  async delete(getBody: ProductChoiceDeleteReqDto): Promise<void> {
    const { idList } = getBody;
    await this.assertAllChoiceProductsExist(idList);

    const waitCount = await this.countWaitDeliveries(idList);
    if (waitCount > 0) {
      throw new BadRequestException(`발송 대기 중인 쿠폰이 있어 삭제할 수 없습니다. (${waitCount}건)`);
    }

    await this.productRepository.softDelete({ id: In(idList) });
  }

  // 구성상품을 쓰기 락과 함께 id 오름차순으로 읽는다.
  // 락이 없으면 구성상품 상태를 읽은 뒤 매핑을 만들기 전에 그 상품이 미사용으로 바뀔 수 있다.
  // 이때 ProductService 의 동기화는 아직 없는 매핑을 못 찾고, 여기서는 옛 상태로 USE 를 저장해
  // 미사용 구성상품을 가진 초이스쿠폰이 USE 로 남는다.
  // ProductService.syncChoiceUseStatus 와 같은 순서(id 오름차순)로 잠가 데드락을 피한다.
  private async findComponentsWithLock(productIdList: number[]): Promise<ProductEntity[]> {
    const uniqueIds = [...new Set(productIdList)].sort((a, b) => a - b);

    if (uniqueIds.length === 0) {
      return [];
    }

    return this.productRepository
      .createQueryBuilder('product')
      .setLock('pessimistic_write')
      .where('product.id IN (:...ids)', { ids: uniqueIds })
      .orderBy('product.id', 'ASC')
      .getMany();
  }

  // 초이스쿠폰이 자동으로 미사용된 상태인지 마지막 사용상태 이력으로 판별한다.
  // ProductService.wasAutoUnused 와 같은 도메인 규칙(isAutoUnusedByHistory)을 쓴다.
  // 호출부가 초이스쿠폰 행 쓰기 락을 잡은 뒤 부르므로 최신 이력을 본다.
  private async isAutoUnused(choiceProductId: number): Promise<boolean> {
    const lastUseStatusHistory = await this.productUpdateHistoryRepository.findOne({
      where: {
        productId: choiceProductId,
        key: In(['useStatus', ProductUseStatusAutoHistoryKey]),
      },
      order: { id: 'DESC' },
    });

    return isAutoUnusedByHistory(lastUseStatusHistory);
  }

  // 사용상태 이력을 남긴다. 마지막 이력의 key 로 수동/자동을 구분하므로 key 선택이 중요하다.
  //
  // requested 와 afterValue 가 다르면 구성상품 때문에 보정된 것이므로 자동 강등으로 본다.
  // 이 경우 ProductUseStatusAutoHistoryKey 로 남겨야 구성상품이 회복될 때 자동으로 복구된다.
  // 관리자가 요청한 값 그대로 저장됐다면 수동 변경이므로 'useStatus' 로 남긴다.
  private async saveUseStatusHistory(
    user: ILoginUserInfo,
    productId: number,
    beforeValue: IProductUseStatus | null,
    afterValue: IProductUseStatus,
    requested: IProductUseStatus,
  ): Promise<void> {
    const isAutoAdjusted = requested !== afterValue;
    const key = isAutoAdjusted ? ProductUseStatusAutoHistoryKey : 'useStatus';

    const history = new ProductUpdateHistoryEntity();
    history.productId = productId;
    history.userId = user.id;
    history.key = key;
    history.keyName = ProductUpdateHistoryKeyName(key);
    history.beforeValue = beforeValue;
    history.afterValue = afterValue;
    history.reason = isAutoAdjusted ? '구성상품 사용상태에 따른 자동 반영' : null;

    await this.productUpdateHistoryRepository.insert(history);
  }

  // 구성상품에 미사용/영구미사용이 있으면 초이스쿠폰은 사용 상태가 될 수 없다.
  // 요청이 미사용이면 그대로 존중한다(구성상품이 정상이라고 임의로 사용으로 올리지 않는다).
  private applyComponentUseStatus(requested: IProductUseStatus, components: ProductEntity[]): IProductUseStatus {
    if (requested !== IProductUseStatus.USE) {
      return requested;
    }
    return resolveChoiceUseStatus(components.map((component) => component.useStatus));
  }

  private async assertAllChoiceProductsExist(idList: number[]): Promise<void> {
    const count = await this.productRepository.countBy({ id: In(idList), type: IProductType.CHOICE });
    if (count !== idList.length) {
      throw new BadRequestException('존재하지 않는 초이스쿠폰이 포함되어 있습니다.');
    }
  }

  private async countWaitDeliveries(choiceProductIdList: number[]): Promise<number> {
    return this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoin('orderDelivery.orderProductMapping', 'orderProductMapping')
      .where('orderProductMapping.productId IN (:...ids)', { ids: choiceProductIdList })
      .andWhere('orderDelivery.status = :status', { status: IOrderDeliveryStatus.WAIT })
      .getCount();
  }

  private async countPendingCustomerDeliveries(choiceProductIdList: number[]): Promise<number> {
    return this.orderDeliveryRepository
      .createQueryBuilder('orderDelivery')
      .innerJoin('orderDelivery.orderProductMapping', 'orderProductMapping')
      .where('orderProductMapping.productId IN (:...ids)', { ids: choiceProductIdList })
      .andWhere('orderDelivery.actualSendAt IS NOT NULL')
      .andWhere('orderDelivery.choiceSelectProductId IS NULL')
      .getCount();
  }
}
