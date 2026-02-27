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
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';
import { ILoginUserInfo } from '../../auth/interface/login.user';

@Injectable()
export class SsgEventService {
  constructor(
    @InjectRepository(SsgEventEntity)
    private readonly ssgEventRepository: Repository<SsgEventEntity>,
    @InjectRepository(SsgEventAmountHistoryEntity)
    private readonly amountHistoryRepository: Repository<SsgEventAmountHistoryEntity>,
    @InjectRepository(OrderProductMappingEntity)
    private readonly orderProductMappingRepository: Repository<OrderProductMappingEntity>,
    private readonly activityLogService: ActivityLogService,
  ) {}

  async getList(getQuery: SsgEventGetListReqDto): Promise<SsgEventGetListResDto> {
    const { take, page, code, createdEndAt, createdStartAt, name } = getQuery;
    const skip = (page - 1) * take;

    const now = new Date();

    let queryBuilder = this.ssgEventRepository.createQueryBuilder('ssg');

    if (code) {
      queryBuilder = queryBuilder.andWhere('ssg.code LIKE :code', { code: '%' + code + '%' });
    }

    if (name) {
      queryBuilder = queryBuilder.andWhere('ssg.name LIKE :name', { name: '%' + name + '%' });
    }

    // 조회기간이 설정되지 않은 경우에만 현재 진행 중인 행사 필터 적용
    if (!createdStartAt && !createdEndAt) {
      queryBuilder = queryBuilder
        .andWhere('ssg.startAt <= :now', { now })
        .andWhere('ssg.endAt >= :now', { now });
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
      const productPrice = orderProductMapping.product.price;
      // 발송대기: 주문완료, 검토완료, 발송확정 상태 (임시저장 제외)
      const isOrderWait =
        orderProductMapping.order.status === 'DELIVERY_REQUEST' ||
        orderProductMapping.order.status === 'REVIEW_COMPLETE' ||
        orderProductMapping.order.status === 'DELIVERY_CONFIRMED';

      for (const orderDelivery of orderProductMapping.orderDeliveries) {
        if (!orderDelivery.ssgEventId) {
          continue;
        }
        const ssgEventId = orderDelivery.ssgEventId;

        const oneSsgEventCount = ssgEventCountMap.get(ssgEventId);
        // 발송완료: 배송건 상태가 COMPLETE 또는 COMPLETE_SMS
        const isComplete = orderDelivery.status === 'COMPLETE' || orderDelivery.status === 'COMPLETE_SMS';

        // 배송건별로 건수와 금액 계산
        // - 발송대기: 주문 상태 기준 (주문완료, 검토완료, 발송확정)
        // - 발송완료: 배송건 상태 기준 (COMPLETE, COMPLETE_SMS)
        if (!oneSsgEventCount) {
          ssgEventCountMap.set(ssgEventId, {
            deliveryWaitCount: isOrderWait ? 1 : 0,
            deliveryWaitAmount: isOrderWait ? productPrice : 0,
            deliveryCompleteCount: isComplete ? 1 : 0,
            deliveryCompleteAmount: isComplete ? productPrice : 0,
          });
        } else {
          ssgEventCountMap.set(ssgEventId, {
            deliveryWaitCount: isOrderWait
              ? oneSsgEventCount.deliveryWaitCount + 1
              : oneSsgEventCount.deliveryWaitCount,
            deliveryWaitAmount: isOrderWait
              ? oneSsgEventCount.deliveryWaitAmount + productPrice
              : oneSsgEventCount.deliveryWaitAmount,
            deliveryCompleteCount: isComplete
              ? oneSsgEventCount.deliveryCompleteCount + 1
              : oneSsgEventCount.deliveryCompleteCount,
            deliveryCompleteAmount: isComplete
              ? oneSsgEventCount.deliveryCompleteAmount + productPrice
              : oneSsgEventCount.deliveryCompleteAmount,
          });
        }
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

  async excelDownload(user: ILoginUserInfo, getBody: SsgEventExcelDownloadReqDto) {
    const startTime = Date.now();
    const { code, createdEndAt, createdStartAt, name, password, downloadReason } = getBody;

    // 비밀번호 검증
    await this.activityLogService.verifyPassword(user.id, password);

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
      const productPrice = orderProductMapping.product.price;
      // 발송대기: 주문완료, 검토완료, 발송확정 상태 (임시저장 제외)
      const isOrderWait =
        orderProductMapping.order.status === 'DELIVERY_REQUEST' ||
        orderProductMapping.order.status === 'REVIEW_COMPLETE' ||
        orderProductMapping.order.status === 'DELIVERY_CONFIRMED';

      for (const orderDelivery of orderProductMapping.orderDeliveries) {
        if (!orderDelivery.ssgEventId) {
          continue;
        }
        const ssgEventId = orderDelivery.ssgEventId;

        const oneSsgEventCount = ssgEventCountMap.get(ssgEventId);
        // 발송완료: 배송건 상태가 COMPLETE 또는 COMPLETE_SMS
        const isComplete = orderDelivery.status === 'COMPLETE' || orderDelivery.status === 'COMPLETE_SMS';

        // 배송건별로 건수와 금액 계산
        // - 발송대기: 주문 상태 기준 (주문완료, 검토완료, 발송확정)
        // - 발송완료: 배송건 상태 기준 (COMPLETE, COMPLETE_SMS)
        if (!oneSsgEventCount) {
          ssgEventCountMap.set(ssgEventId, {
            deliveryWaitCount: isOrderWait ? 1 : 0,
            deliveryWaitAmount: isOrderWait ? productPrice : 0,
            deliveryCompleteCount: isComplete ? 1 : 0,
            deliveryCompleteAmount: isComplete ? productPrice : 0,
          });
        } else {
          ssgEventCountMap.set(ssgEventId, {
            deliveryWaitCount: isOrderWait
              ? oneSsgEventCount.deliveryWaitCount + 1
              : oneSsgEventCount.deliveryWaitCount,
            deliveryWaitAmount: isOrderWait
              ? oneSsgEventCount.deliveryWaitAmount + productPrice
              : oneSsgEventCount.deliveryWaitAmount,
            deliveryCompleteCount: isComplete
              ? oneSsgEventCount.deliveryCompleteCount + 1
              : oneSsgEventCount.deliveryCompleteCount,
            deliveryCompleteAmount: isComplete
              ? oneSsgEventCount.deliveryCompleteAmount + productPrice
              : oneSsgEventCount.deliveryCompleteAmount,
          });
        }
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

    // 성공 로그 저장
    const responseTime = Date.now() - startTime;
    const recordCount = resultList.length;
    const { password: _, ...requestParams } = getBody;

    await this.activityLogService.createLog({
      userId: user.id,
      userEmail: user.email,
      method: 'POST',
      requestUrl: '/ssg-event/excel-download',
      actionType: 'EXCEL_DOWNLOAD',
      ipAddress: '',
      userAgent: '',
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime,
      downloadReason,
      recordCount,
      requestParams,
      errorMessage: undefined,
    });

    return { fileName, filePath };
  }

  async create(getBody: SsgEventCreateReqDto) {
    const { code, no, order, name, startAt, endAt, couponExpiration, eventPrice } = getBody;
    const orderInsert = order ? order : 1;

    // endAt을 해당 날짜의 23:59:59로 설정
    const endAtDate = new Date(endAt);
    endAtDate.setHours(23, 59, 59);

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
      .orderBy('ssg.id', 'ASC');

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
      .orderBy('ssg.id', 'ASC');

    if (couponExpiration) {
      queryBuilder = queryBuilder.andWhere('ssg.couponExpiration = :couponExpiration', { couponExpiration });
    }

    const event = await queryBuilder.getOne();
    return event;
  }

  /**
   * 배송건별로 행사를 할당합니다.
   * 각 배송건(상품권)은 하나의 행사에서 전액 처리되어야 합니다.
   * 모든 배송건 할당 가능 시에만 결과 반환, 하나라도 불가하면 null 반환 (All or Nothing)
   * @param deliveries 배송건 정보 배열 [{ deliveryId, price }]
   * @param couponExpiration 쿠폰 유효기간
   * @returns 할당 결과 배열 [{ deliveryId, eventId, price }] 또는 null (잔액 부족)
   */
  async allocateEventsForDeliveries(
    deliveries: { deliveryId: number; price: number }[],
    couponExpiration?: number,
  ): Promise<{ deliveryId: number; eventId: number; price: number }[] | null> {
    const now = new Date();

    // 유효한 행사 목록 조회 (id 기준 정렬 - 먼저 등록한 행사 우선, 잔액 > 0)
    let queryBuilder = this.ssgEventRepository
      .createQueryBuilder('ssg')
      .where('ssg.startAt <= :now', { now })
      .andWhere('ssg.endAt >= :now', { now })
      .andWhere('ssg.eventBalance > 0')
      .orderBy('ssg.id', 'ASC');

    if (couponExpiration) {
      queryBuilder = queryBuilder.andWhere('ssg.couponExpiration = :couponExpiration', { couponExpiration });
    }

    const events = await queryBuilder.getMany();

    if (events.length === 0) {
      return null;
    }

    // 각 행사의 잔여 잔액을 추적 (실제 차감 전 시뮬레이션)
    const eventBalances = new Map<number, number>();
    for (const event of events) {
      eventBalances.set(event.id, event.eventBalance);
    }

    const allocations: { deliveryId: number; eventId: number; price: number }[] = [];

    // 각 배송건에 대해 행사 할당
    for (const delivery of deliveries) {
      let allocated = false;

      for (const event of events) {
        const remainingBalance = eventBalances.get(event.id) || 0;

        // 현재 행사 잔액이 상품 가격 이상이면 할당
        if (remainingBalance >= delivery.price) {
          allocations.push({
            deliveryId: delivery.deliveryId,
            eventId: event.id,
            price: delivery.price,
          });

          // 잔액 차감 (시뮬레이션)
          eventBalances.set(event.id, remainingBalance - delivery.price);
          allocated = true;
          break;
        }
      }

      // 어떤 행사에서도 처리 못하면 잔액 부족
      if (!allocated) {
        return null;
      }
    }

    return allocations;
  }

  /**
   * 여러 행사에서 분할 차감합니다.
   * @param allocations 할당 정보 배열 [{ deliveryId, eventId, price }]
   * @param orderId 주문 ID
   * @param isTemporary 가차감 여부
   */
  async deductEventBalanceMultiple(
    allocations: { deliveryId: number; eventId: number; price: number }[],
    orderId: number,
    isTemporary: boolean = true,
  ): Promise<void> {
    // 행사별로 차감 금액 합산
    const eventDeductions = new Map<number, number>();
    for (const alloc of allocations) {
      const current = eventDeductions.get(alloc.eventId) || 0;
      eventDeductions.set(alloc.eventId, current + alloc.price);
    }

    // 각 행사에서 차감
    for (const [eventId, totalAmount] of eventDeductions) {
      const ssgEvent = await this.ssgEventRepository.findOne({
        where: { id: eventId },
      });

      if (!ssgEvent) {
        throw new BadRequestException(`유효한 이벤트가 없습니다. (eventId: ${eventId})`);
      }

      if (ssgEvent.eventBalance < totalAmount) {
        throw new BadRequestException(`이벤트 잔액이 부족합니다. (eventId: ${eventId})`);
      }

      const newBalance = ssgEvent.eventBalance - totalAmount;

      const ssgEventAmountHistory = this.amountHistoryRepository.create({
        ssgEventId: ssgEvent.id,
        amount: -totalAmount,
        balance: newBalance,
        orderId,
        isTemporary,
      });

      ssgEvent.eventBalance = newBalance;
      await this.amountHistoryRepository.save(ssgEventAmountHistory);
      await this.ssgEventRepository.save(ssgEvent);
    }
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

  /**
   * 개별 배송건 PIN 발급 실패 시 해당 금액만 환불
   * @param ssgEventId SSG 이벤트 ID
   * @param orderId 주문 ID
   * @param amount 환불할 금액 (상품 가격)
   */
  async refundForDeliveryFail(ssgEventId: number, orderId: number, amount: number): Promise<void> {
    const ssgEvent = await this.ssgEventRepository.findOne({
      where: { id: ssgEventId },
    });

    if (!ssgEvent) {
      return;
    }

    const restoredBalance = ssgEvent.eventBalance + amount;

    const refundHistory = this.amountHistoryRepository.create({
      ssgEventId: ssgEvent.id,
      amount,
      balance: restoredBalance,
      orderId,
      isTemporary: false,
    });

    ssgEvent.eventBalance = restoredBalance;
    await this.amountHistoryRepository.save(refundHistory);
    await this.ssgEventRepository.save(ssgEvent);
  }

  /**
   * 재발송 시 환불 복구 (refundForDeliveryFail의 역연산)
   * PIN 재발급 성공 시 이전에 환불된 금액을 다시 차감
   * @param ssgEventId SSG 이벤트 ID
   * @param orderId 주문 ID
   * @param amount 차감할 금액 (상품 가격)
   */
  async chargeBackForResend(ssgEventId: number, orderId: number, amount: number): Promise<void> {
    const ssgEvent = await this.ssgEventRepository.findOne({
      where: { id: ssgEventId },
    });

    if (!ssgEvent) {
      return;
    }

    if (ssgEvent.eventBalance < amount) {
      throw new BadRequestException(
        `재발송 잔액 부족 (eventId: ${ssgEventId}, 잔액: ${ssgEvent.eventBalance}, 필요: ${amount})`,
      );
    }

    const newBalance = ssgEvent.eventBalance - amount;

    const chargeHistory = this.amountHistoryRepository.create({
      ssgEventId: ssgEvent.id,
      amount: -amount,
      balance: newBalance,
      orderId,
      isTemporary: false,
    });

    ssgEvent.eventBalance = newBalance;
    await this.amountHistoryRepository.save(chargeHistory);
    await this.ssgEventRepository.save(ssgEvent);
  }
}
