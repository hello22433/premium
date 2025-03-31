import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderEntity } from '../../entity/order.entity';
import { OrderLikeEntity } from '../../entity/order.like.entity';
import { Repository } from 'typeorm';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { OrderEventGetListReqQueryDto, OrderEventSetLikeReqDto } from '../api/order.event.req.dto';
import { format } from 'date-fns';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { OrderEventViewDto } from '../api/dto/order.event.view.dto';
import { IUserAuthority } from '../../user/interface/user.authority';

@Injectable()
export class OrderEventService {
  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderLikeEntity)
    private readonly orderLikeRepository: Repository<OrderLikeEntity>,
  ) {}

  async getList(user: ILoginUserInfo, getQuery: OrderEventGetListReqQueryDto) {
    const { type, productName, brandName, isLike, page, take } = getQuery;

    let queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.user', 'user')
      .innerJoinAndSelect('order.orderProductMappings', 'orderProductMappings')
      .innerJoinAndSelect('orderProductMappings.product', 'product')
      .innerJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('order.orderLikes', 'orderLikes')
      .where('order.type = :type', { type })
      .andWhere('order.status != :status', { status: 'TEMP' });

    if (user.authority !== IUserAuthority.SUPER_ADMIN) {
      queryBuilder = queryBuilder.andWhere('order.userId = :userId', { userId: user.id });
    }

    if (productName) {
      queryBuilder = queryBuilder.andWhere('product.name = :productName', { productName: `%${productName}%` });
    }

    if (brandName) {
      queryBuilder = queryBuilder.andWhere('(brand.nameKorean LIKE :brandName OR brand.nameEnglish LIKE :brandName)', {
        brandName: `%${brandName}%`,
      });
    }

    if (isLike !== undefined) {
      queryBuilder = queryBuilder
        .andWhere('orderLikes.userId = :userId', { userId: user.id })
        .andWhere('orderLikes.isLike = :isLike', { isLike });
    }

    queryBuilder = queryBuilder.orderBy('order.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.take(take).skip(skip);
    const [orderList, totalCount] = await queryBuilder.getManyAndCount();
    const totalPage = Math.ceil(totalCount / take);

    const resultList: OrderEventViewDto[] = orderList.map((order) => {
      let totalAmount = 0;
      let totalProductCount = 0;
      let productName = '';
      if (order.orderProductMappings && order.orderProductMappings.length > 0) {
        totalAmount = order.orderProductMappings.reduce((acc, cur) => {
          return acc + cur.amount;
        }, 0);
        totalProductCount = order.orderProductMappings.length;
        productName = order.orderProductMappings[0].product.name;
        const orderProductMappingsLength = order.orderProductMappings.length;
        if (orderProductMappingsLength - 1 > 0) {
          productName += `외 ${orderProductMappingsLength - 1}건`;
        }
      }

      let isLike = false;
      if (order.orderLikes) {
        for (const orderLike of order.orderLikes) {
          if (orderLike.userId === user.id) {
            isLike = orderLike.isLike;
            break;
          }
        }
      }

      return {
        id: order.id,
        registerAt: format(order.registerAt, DateFormatStr),
        code: order.code,
        eventName: order.eventName,
        productName: productName,
        productCount: totalProductCount,
        deliveryCount: totalAmount,
        isLike,
      };
    });

    return { list: resultList, totalPage, totalCount, currentPage: page };
  }

  async setLike(user: ILoginUserInfo, getBody: OrderEventSetLikeReqDto) {
    const { orderId, isLike } = getBody;
    let orderLike = await this.orderLikeRepository.findOne({
      where: { orderId, userId: user.id },
    });

    if (orderLike) {
      orderLike.isLike = isLike;
    } else {
      orderLike = new OrderLikeEntity();
      orderLike.orderId = orderId;
      orderLike.userId = user.id;
      orderLike.isLike = isLike;
    }

    await this.orderLikeRepository.save(orderLike);

    return;
  }
}
