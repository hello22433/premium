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
import { ProductChoiceMappingEntity } from '../../entity/product.choice.mapping.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { Transactional } from 'typeorm-transactional';
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
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
  ) {}

  async getList(getQuery: ProductChoiceGetListReqQueryDto): Promise<ProductChoiceGetListResDto> {
    const { createdStartAt, createdEndAt, name, code, expireDay, price, page, take } = getQuery;
    let queryBuilder = this.productRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.productChoiceMappings', 'productChoiceMappings')
      .innerJoinAndSelect('productChoiceMappings.product', 'subProduct')
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
      return {
        id: product.id,
        createdDate: format(product.createdAt, DateDateFormatStr),
        code: product.code,
        name: product.name,
        productComposition: product.productChoiceMappings[0].product?.name ?? '',
        productCount: product.productChoiceMappings.length,
        usagePeriod: '2024-01-01~2024-12-31', // TODO:
        useStatus: product.useStatus,
        registrationStatus: '정상', // TODO:
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

  @Transactional()
  async create(getBody: ProductChoiceCreateReqDto) {
    const { name, productIdList, useStatus } = getBody;
    let { imagePath } = getBody;

    const products = await this.productRepository.find({ where: { id: In(productIdList) } });

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
      useStatus: useStatus,
    });

    const newChoiceProduct = await this.productRepository.save(insertedProduct);

    const newChoiceProductId = newChoiceProduct.id;

    const productChoiceMappings = productIdList.map((productId) => {
      return this.productChoiceMappingRepository.create({
        choiceProductId: newChoiceProductId,
        productId: productId,
      });
    });

    await this.productChoiceMappingRepository.insert(productChoiceMappings);

    return;
  }

  @Transactional()
  async update(getBody: ProductChoiceUpdateReqDto) {
    const { id, name, productIdList, useStatus } = getBody;
    let { imagePath } = getBody;

    const product = await this.productRepository.findOne({ where: { id: id, type: IProductType.CHOICE } });

    if (!product) {
      throw new BadRequestException('존재하지 않는 상품입니다.');
    }

    const products = await this.productRepository.find({ where: { id: In(productIdList) } });

    if (products.length !== productIdList.length) {
      throw new BadRequestException(`존재하지 않거나 삭제된 상품이 있습니다.`);
    }

    const initialPrice = products[0].price;
    imagePath = imagePath ? imagePath : products[0].imagePath;
    if (!products.every((product) => product.price === initialPrice)) {
      throw new BadRequestException(`가격이 다른 상품이 포함 되어 있습니다.`);
    }

    await this.productRepository.update(id, {
      type: IProductType.CHOICE,
      name,
      imagePath: imagePath!,
      price: initialPrice,
      useStatus: useStatus,
    });

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
