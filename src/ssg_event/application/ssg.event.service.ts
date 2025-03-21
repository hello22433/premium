import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { Repository } from 'typeorm';
import { SsgEventCreateReqDto, SsgEventGetListReqDto, SsgEventUpdateAmountReqDto } from '../api/ssg.event.req.dto';
import { SsgEventGetListResDto } from '../api/ssg.event.res.dto';
import { SsgEventViewDto } from '../api/dto/ssg.event.view.dto';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { SsgEventAmountHistoryEntity } from '../../entity/ssg.event.amount.history.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { IOrderType } from '../../order/interface/order.type';

@Injectable()
export class SsgEventService {
  constructor(
    @InjectRepository(SsgEventEntity)
    private readonly ssgEventRepository: Repository<SsgEventEntity>,
    @InjectRepository(SsgEventAmountHistoryEntity)
    private readonly amountHistoryRepository: Repository<SsgEventAmountHistoryEntity>,
    @InjectRepository(OrderProductMappingEntity)
    private readonly orderProductMappingRepository: Repository<OrderProductMappingEntity>,
  ) {}

  async getList(getQuery: SsgEventGetListReqDto): Promise<SsgEventGetListResDto> {
    const { take, page, code, createdEndAt, createdStartAt, name } = getQuery;
    const skip = (page - 1) * take;

    let queryBuilder = this.ssgEventRepository.createQueryBuilder('ssg');

    if (code) {
      queryBuilder = queryBuilder.andWhere('ssg.code LIKE :code', { code: '%' + code + '%' });
    }

    if (name) {
      queryBuilder = queryBuilder.andWhere('ssg.name LIKE :name', { name: '%' + name + '%' });
    }

    if (createdStartAt && !createdEndAt) {
      queryBuilder = queryBuilder.andWhere('ssg.createdAt >= :createdStartAt', {
        createdStartAt: new Date(createdStartAt),
      });
    }

    if (!createdStartAt && createdEndAt) {
      queryBuilder = queryBuilder.andWhere('ssg.createdAt <= :createdEndAt', {
        createdEndAt: new Date(createdEndAt),
      });
    }

    if (createdStartAt && createdEndAt) {
      queryBuilder = queryBuilder.andWhere('ssg.createdAt BETWEEN :createdStartAt AND :createdEndAt', {
        createdStartAt: new Date(createdStartAt),
        createdEndAt: new Date(createdEndAt),
      });
    }

    const [eventList, totalCount] = await queryBuilder.skip(skip).take(take).getManyAndCount();

    const ssgEventIdList = eventList.map((event) => event.id);
    const orderProductMappingList = await this.orderProductMappingRepository
      .createQueryBuilder('orderProductMapping')
      .innerJoinAndSelect('orderProductMapping.product', 'product')
      .innerJoinAndSelect('orderProductMapping.order', 'order')
      .innerJoinAndSelect('orderProductMapping.orderDeliveries', 'orderDeliveries')
      .where('orderDeliveries.ssgEventId IN (:...ssgEventIdList)', { ssgEventIdList })
      .andWhere('order.type = :type', { type: IOrderType.SSG })
      .getMany();

    // <ssgEventId, >
    const ssgEventCountMap = new Map<
      number,
      {
        deliveryWaitCount: number;
        deliveryWaitAmount: number;
        deliveryCompleteCount: number;
        deliveryCompleteAmount: number;
      }
    >();

    for (const orderProductMapping of orderProductMappingList) {
      let ssgEventId: number | null = null;
      for (const orderDelivery of orderProductMapping.orderDeliveries) {
        if (!orderDelivery.ssgEventId) {
          continue;
        }
        ssgEventId = orderDelivery.ssgEventId;

        const oneSsgEventCount = ssgEventCountMap.get(ssgEventId);
        if (!oneSsgEventCount) {
          ssgEventCountMap.set(ssgEventId, {
            deliveryWaitCount: orderDelivery.status === 'WAIT' ? 1 : 0,
            deliveryWaitAmount: 0,
            deliveryCompleteCount: orderDelivery.status === 'COMPLETE' ? 1 : 0,
            deliveryCompleteAmount: 0,
          });
        } else {
          ssgEventCountMap.set(ssgEventId, {
            deliveryWaitCount:
              orderDelivery.status === 'WAIT'
                ? oneSsgEventCount.deliveryWaitCount + 1
                : oneSsgEventCount.deliveryWaitCount,
            deliveryWaitAmount: oneSsgEventCount.deliveryWaitAmount,
            deliveryCompleteCount:
              orderDelivery.status === 'COMPLETE'
                ? oneSsgEventCount.deliveryCompleteCount + 1
                : oneSsgEventCount.deliveryCompleteCount,
            deliveryCompleteAmount: oneSsgEventCount.deliveryCompleteAmount,
          });
        }
      }

      const afterSsgEventCount = ssgEventCountMap.get(ssgEventId!);
      if (!afterSsgEventCount) {
        throw new InternalServerErrorException('ssg event id error');
      }

      if (orderProductMapping.order.status === 'DELIVERY_CONFIRMED') {
        afterSsgEventCount.deliveryWaitAmount += orderProductMapping.amount * orderProductMapping.product.price;
      }

      if (orderProductMapping.order.status === 'DELIVERY_COMPLETE') {
        afterSsgEventCount.deliveryCompleteAmount += orderProductMapping.amount * orderProductMapping.product.price;
      }

      if (!ssgEventId) {
        throw new InternalServerErrorException('ssg event id error');
      }
    }

    const totalPage = Math.ceil(totalCount / take);

    const resultList: SsgEventViewDto[] = eventList.map((event) => {
      const oneSsgEventCount = ssgEventCountMap.get(event.id);
      return {
        id: event.id,
        order: event.order,
        no: event.no,
        code: event.code,
        name: event.name,
        startAt: format(event.startAt, DateFormatStr),
        endAt: format(event.endAt, DateFormatStr),
        eventPrice: event.eventPrice,
        eventBalance: event.eventBalance,
        deliveryWaitCount: oneSsgEventCount?.deliveryWaitCount ?? 0,
        deliveryWaitAmount: oneSsgEventCount?.deliveryWaitAmount ?? 0,
        deliveryCompleteCount: oneSsgEventCount?.deliveryCompleteCount ?? 0,
        deliveryCompleteAmount: oneSsgEventCount?.deliveryCompleteAmount ?? 0,
      };
    });

    return { list: resultList, totalCount, totalPage, currentPage: page };
  }

  async create(getBody: SsgEventCreateReqDto) {
    const { code, no, order, name, startAt, endAt, couponExpiration, eventPrice } = getBody;
    const orderInsert = order ? order : 1;
    await this.ssgEventRepository.insert({
      code,
      order: orderInsert,
      no: no,
      name,
      startAt: new Date(startAt),
      endAt: new Date(endAt),
      couponExpiration,
      eventPrice,
    });
    return;
  }

  async updateAmount(getBody: SsgEventUpdateAmountReqDto) {
    const { id, amount } = getBody;

    const ssgEvent = await this.ssgEventRepository.findOne({
      where: {
        id,
      },
    });

    if (!ssgEvent) {
      throw new BadRequestException('존재하지 않는 이벤트입니다.');
    }

    const lastHistory = await this.amountHistoryRepository.findOne({
      where: {
        ssgEventId: id,
      },
      order: {
        createdAt: 'DESC',
      },
    });

    const lastBalance = lastHistory ? lastHistory.balance : 0;
    const newBalance = lastBalance + amount;

    const ssgEventAmountHistory = this.amountHistoryRepository.create({
      ssgEventId: ssgEvent.id,
      amount: amount,
      balance: newBalance,
    });
    ssgEvent.eventBalance = newBalance;
    await this.amountHistoryRepository.save(ssgEventAmountHistory);
    await this.ssgEventRepository.save(ssgEvent);
  }
}
