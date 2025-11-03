import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { Repository } from 'typeorm';
import {
  SsgEventCreateReqDto,
  SsgEventExcelDownloadReqDto,
  SsgEventGetListReqDto,
  SsgEventGetValidListReqDto,
  SsgEventUpdateAmountReqDto,
} from '../api/ssg.event.req.dto';
import { SsgEventGetListResDto, SsgEventGetValidListResDto } from '../api/ssg.event.res.dto';
import { SsgEventViewDto } from '../api/dto/ssg.event.view.dto';
import { DateDateFormatStr, DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { SsgEventAmountHistoryEntity } from '../../entity/ssg.event.amount.history.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { IOrderType } from '../../order/interface/order.type';
import * as ExcelJS from 'exceljs';
import { join } from 'path';
import * as process from 'node:process';
import { QueryBuilderDateCondition } from '../../common/infra/query.builder.date.condition';

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

    const currentMonth = new Date().getMonth() + 1;

    let queryBuilder = this.ssgEventRepository.createQueryBuilder('ssg');

    if (code) {
      queryBuilder = queryBuilder.andWhere('ssg.code LIKE :code', { code: '%' + code + '%' });
    }

    if (name) {
      queryBuilder = queryBuilder.andWhere('ssg.name LIKE :name', { name: '%' + name + '%' });
    }

    // 조회기간이 설정되지 않은 경우에만 현재 월 필터 적용
    if (!createdStartAt && !createdEndAt) {
      queryBuilder = queryBuilder
        .andWhere('MONTH(ssg.startAt) <= :currentMonth', { currentMonth })
        .andWhere('MONTH(ssg.endAt) >= :currentMonth', { currentMonth });
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'ssg', 'createdAt', createdStartAt, createdEndAt);

    const [eventList, totalCount] = await queryBuilder.skip(skip).take(take).getManyAndCount();

    const ssgEventIdList = eventList.map((event) => event.id);

    // ssgEventIdList가 비어있을 때 빈 배열 반환
    let orderProductMappingList: OrderProductMappingEntity[] = [];
    if (ssgEventIdList.length > 0) {
      orderProductMappingList = await this.orderProductMappingRepository
        .createQueryBuilder('orderProductMapping')
        .innerJoinAndSelect('orderProductMapping.product', 'product')
        .innerJoinAndSelect('orderProductMapping.order', 'order')
        .innerJoinAndSelect('orderProductMapping.orderDeliveries', 'orderDeliveries')
        .where('orderDeliveries.ssgEventId IN (:...ssgEventIdList)', { ssgEventIdList })
        .andWhere('order.type = :type', { type: IOrderType.SSG })
        .orderBy('order.id', 'DESC')
        .getMany();
    }

    // <ssgEventId>
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
        const isComplete = orderDelivery.status === 'COMPLETE' || orderDelivery.status === 'COMPLETE_SMS';
        if (!oneSsgEventCount) {
          ssgEventCountMap.set(ssgEventId, {
            deliveryWaitCount: orderDelivery.status === 'WAIT' ? 1 : 0,
            deliveryWaitAmount: 0,
            deliveryCompleteCount: isComplete ? 1 : 0,
            deliveryCompleteAmount: 0,
          });
        } else {
          ssgEventCountMap.set(ssgEventId, {
            deliveryWaitCount:
              orderDelivery.status === 'WAIT'
                ? oneSsgEventCount.deliveryWaitCount + 1
                : oneSsgEventCount.deliveryWaitCount,
            deliveryWaitAmount: oneSsgEventCount.deliveryWaitAmount,
            deliveryCompleteCount: isComplete
              ? oneSsgEventCount.deliveryCompleteCount + 1
              : oneSsgEventCount.deliveryCompleteCount,
            deliveryCompleteAmount: oneSsgEventCount.deliveryCompleteAmount,
          });
        }
      }

      if (!ssgEventId) {
        continue;
      }

      const afterSsgEventCount = ssgEventCountMap.get(ssgEventId);
      if (!afterSsgEventCount) {
        throw new InternalServerErrorException('ssg event id error');
      }

      if (orderProductMapping.order.status === 'DELIVERY_CONFIRMED') {
        afterSsgEventCount.deliveryWaitAmount += orderProductMapping.amount * orderProductMapping.product.price;
      }

      if (orderProductMapping.order.status === 'DELIVERY_COMPLETE') {
        afterSsgEventCount.deliveryCompleteAmount += orderProductMapping.amount * orderProductMapping.product.price;
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

    // 빈 결과일 때 안내 메시지 추가
    const response: any = { list: resultList, totalCount, totalPage, currentPage: page };

    if (resultList.length === 0) {
      if (createdStartAt || createdEndAt) {
        response.emptyMessage = '선택한 조회기간에 해당하는 신세계 행사가 없습니다.';
      } else {
        response.emptyMessage = '현재 진행 중인 신세계 행사가 없습니다.';
      }
    }

    return response;
  }

  async excelDownload(getBody: SsgEventExcelDownloadReqDto) {
    const { code, createdEndAt, createdStartAt, name } = getBody;

    const now = new Date();
    const nowString = format(now, 'yyyyMMdd');

    let queryBuilder = this.ssgEventRepository.createQueryBuilder('ssg');

    if (code) {
      queryBuilder = queryBuilder.andWhere('ssg.code LIKE :code', { code: '%' + code + '%' });
    }

    if (name) {
      queryBuilder = queryBuilder.andWhere('ssg.name LIKE :name', { name: '%' + name + '%' });
    }

    queryBuilder = QueryBuilderDateCondition(queryBuilder, 'ssg', 'createdAt', createdStartAt, createdEndAt);

    const eventList = await queryBuilder.getMany();

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
        const isComplete = orderDelivery.status === 'COMPLETE' || orderDelivery.status === 'COMPLETE_SMS';
        if (!oneSsgEventCount) {
          ssgEventCountMap.set(ssgEventId, {
            deliveryWaitCount: orderDelivery.status === 'WAIT' ? 1 : 0,
            deliveryWaitAmount: 0,
            deliveryCompleteCount: isComplete ? 1 : 0,
            deliveryCompleteAmount: 0,
          });
        } else {
          ssgEventCountMap.set(ssgEventId, {
            deliveryWaitCount:
              orderDelivery.status === 'WAIT'
                ? oneSsgEventCount.deliveryWaitCount + 1
                : oneSsgEventCount.deliveryWaitCount,
            deliveryWaitAmount: oneSsgEventCount.deliveryWaitAmount,
            deliveryCompleteCount: isComplete
              ? oneSsgEventCount.deliveryCompleteCount + 1
              : oneSsgEventCount.deliveryCompleteCount,
            deliveryCompleteAmount: oneSsgEventCount.deliveryCompleteAmount,
          });
        }
      }

      if (!ssgEventId) {
        continue;
      }

      const afterSsgEventCount = ssgEventCountMap.get(ssgEventId);
      if (!afterSsgEventCount) {
        throw new InternalServerErrorException('ssg event id error');
      }

      if (orderProductMapping.order.status === 'DELIVERY_CONFIRMED') {
        afterSsgEventCount.deliveryWaitAmount += orderProductMapping.amount * orderProductMapping.product.price;
      }

      if (orderProductMapping.order.status === 'DELIVERY_COMPLETE') {
        afterSsgEventCount.deliveryCompleteAmount += orderProductMapping.amount * orderProductMapping.product.price;
      }
    }

    const resultList: SsgEventViewDto[] = eventList.map((event) => {
      const oneSsgEventCount = ssgEventCountMap.get(event.id);
      return {
        id: event.id,
        order: event.order,
        no: event.no,
        code: event.code,
        name: event.name,
        startAt: format(event.startAt, DateDateFormatStr),
        endAt: format(event.endAt, DateDateFormatStr),
        eventPrice: event.eventPrice,
        eventBalance: event.eventBalance,
        deliveryWaitCount: oneSsgEventCount?.deliveryWaitCount ?? 0,
        deliveryWaitAmount: oneSsgEventCount?.deliveryWaitAmount ?? 0,
        deliveryCompleteCount: oneSsgEventCount?.deliveryCompleteCount ?? 0,
        deliveryCompleteAmount: oneSsgEventCount?.deliveryCompleteAmount ?? 0,
      };
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(`sheet1`);

    sheet.columns = [
      { header: '순번', key: 'id', width: 10 },
      { header: '행사번호', key: 'order', width: 32 },
      { header: '행사코드', key: 'code', width: 20 },
      { header: '행사명', key: 'name', width: 20 },
      { header: '행사기간', key: 'date', width: 20 },
      { header: '행사금액', key: 'eventPrice', width: 20 },
      { header: '행사잔액', key: 'eventBalance', width: 20 },
      { header: '발송대기건수', key: 'deliveryWaitCount', width: 20 },
      { header: '발송대기금액', key: 'deliveryWaitAmount', width: 20 },
      { header: '발송완료건수', key: 'deliveryCompleteCount', width: 20 },
      { header: '발송완료금액', key: 'deliveryCompleteAmount', width: 20 },
      { header: '행사순번', key: 'no', width: 20 },
    ];

    let id = 1;
    for (const result of resultList) {
      sheet.addRow({
        id: id,
        order: result.order,
        code: result.code,
        name: result.name,
        date: result.startAt + ' ~ ' + result.endAt,
        eventPrice: result.eventPrice,
        eventBalance: result.eventBalance,
        deliveryWaitCount: result.deliveryWaitCount,
        deliveryWaitAmount: result.deliveryWaitAmount,
        deliveryCompleteCount: result.deliveryCompleteCount,
        deliveryCompleteAmount: result.deliveryCompleteAmount,
        no: result.no,
      });
      id++;
    }

    const fileName = `신세계_${nowString}.xlsx`;
    const filePath = join(process.cwd(), '.', 'public', fileName);

    await workbook.xlsx.writeFile(filePath);

    return { fileName, filePath };
  }

  async create(getBody: SsgEventCreateReqDto) {
    const { code, no, order, name, startAt, endAt, couponExpiration, eventPrice } = getBody;
    const orderInsert = order ? order : 1;

    // endAt을 해당 날짜의 23:59:59로 설정
    const endAtDate = new Date(endAt);
    endAtDate.setHours(23, 59, 59, 999);

    await this.ssgEventRepository.insert({
      code,
      order: orderInsert,
      no: no,
      name,
      startAt: new Date(startAt),
      endAt: endAtDate,
      couponExpiration,
      eventPrice,
      eventBalance: eventPrice, // 등록 시 행사금액을 초기 잔액으로 설정
    });
    return;
  }

  /* 충전 기능 미사용으로 주석처리
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
  */

  async getValidList(getQuery: SsgEventGetValidListReqDto): Promise<SsgEventGetValidListResDto> {
    const { couponExpiration } = getQuery;
    const now = new Date();

    let queryBuilder = this.ssgEventRepository
      .createQueryBuilder('ssg')
      .where('ssg.startAt <= :now', { now })
      .andWhere('ssg.endAt >= :now', { now })
      .andWhere('ssg.eventBalance > 0')
      .orderBy('ssg.order', 'ASC');

    if (couponExpiration) {
      queryBuilder = queryBuilder.andWhere('ssg.couponExpiration = :couponExpiration', { couponExpiration });
    }

    const eventList = await queryBuilder.getMany();

    const resultList: SsgEventViewDto[] = eventList.map((event) => ({
      id: event.id,
      code: event.code,
      no: event.no,
      order: event.order,
      name: event.name,
      startAt: format(event.startAt, DateFormatStr),
      endAt: format(event.endAt, DateFormatStr),
      couponExpiration: event.couponExpiration,
      eventPrice: event.eventPrice,
      eventBalance: event.eventBalance,
      deliveryWaitCount: 0,
      deliveryWaitAmount: 0,
      deliveryCompleteCount: 0,
      deliveryCompleteAmount: 0,
      createdAt: format(event.createdAt, DateFormatStr),
    }));

    return { list: resultList };
  }

  async selectEventForOrder(orderAmount: number, couponExpiration?: number): Promise<SsgEventEntity | null> {
    const now = new Date();

    let queryBuilder = this.ssgEventRepository
      .createQueryBuilder('ssg')
      .where('ssg.startAt <= :now', { now })
      .andWhere('ssg.endAt >= :now', { now })
      .andWhere('ssg.eventBalance >= :orderAmount', { orderAmount })
      .orderBy('ssg.order', 'ASC');

    if (couponExpiration) {
      queryBuilder = queryBuilder.andWhere('ssg.couponExpiration = :couponExpiration', { couponExpiration });
    }

    const event = await queryBuilder.getOne();
    return event;
  }

  async deductEventBalance(
    eventId: number,
    amount: number,
    orderId: number,
    isTemporary: boolean = true,
  ): Promise<void> {
    const ssgEvent = await this.ssgEventRepository.findOne({
      where: { id: eventId },
    });

    if (!ssgEvent) {
      throw new BadRequestException('유효한 이벤트가 없습니다.');
    }

    if (ssgEvent.eventBalance < amount) {
      throw new BadRequestException('이벤트 잔액이 부족합니다.');
    }

    const newBalance = ssgEvent.eventBalance - amount;

    const ssgEventAmountHistory = this.amountHistoryRepository.create({
      ssgEventId: ssgEvent.id,
      amount: -amount,
      balance: newBalance,
      orderId,
      isTemporary,
    });

    ssgEvent.eventBalance = newBalance;
    await this.amountHistoryRepository.save(ssgEventAmountHistory);
    await this.ssgEventRepository.save(ssgEvent);
  }

  async restoreEventBalance(orderId: number): Promise<void> {
    const histories = await this.amountHistoryRepository.find({
      where: { orderId },
    });

    for (const history of histories) {
      if (!history.ssgEventId || !history.amount) {
        continue;
      }

      const ssgEvent = await this.ssgEventRepository.findOne({
        where: { id: history.ssgEventId },
      });

      if (!ssgEvent) {
        continue;
      }

      const restoredBalance = ssgEvent.eventBalance - history.amount;

      const restorationHistory = this.amountHistoryRepository.create({
        ssgEventId: ssgEvent.id,
        amount: -history.amount,
        balance: restoredBalance,
        orderId,
        isTemporary: false,
      });

      ssgEvent.eventBalance = restoredBalance;
      await this.amountHistoryRepository.save(restorationHistory);
      await this.ssgEventRepository.save(ssgEvent);
    }
  }

  async confirmEventBalance(orderId: number): Promise<void> {
    await this.amountHistoryRepository.update({ orderId, isTemporary: true }, { isTemporary: false });
  }
}
