import { BadRequestException, Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { createExportTempPath } from '../../util/file.util';
import { InjectRepository } from '@nestjs/typeorm';
import { ISsgAmountResult, ISsgIssue } from '../../partner_company_extern/interface/ssg.issue';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { SsgReservationRangeEntity } from '../../entity/ssg.reservation.range.entity';
import { Brackets, LessThan, Repository, SelectQueryBuilder } from 'typeorm';
import {
  SsgEventCreateReqDto,
  SsgEventExcelDownloadReqDto,
  SsgEventGetListReqDto,
  SsgEventGetValidListReqDto,
  SsgEventUpdateAmountReqDto,
} from '../api/ssg.event.req.dto';
import {
  SsgEventGetListResDto,
  SsgEventGetValidListResDto,
  SsgReservationRangeViewResDto,
} from '../api/ssg.event.res.dto';
import { SsgEventViewDto } from '../api/dto/ssg.event.view.dto';
import { DateDateFormatStr, DateFormatStr } from '../../common/domain/date.format.str';
import { format } from 'date-fns';
import { SsgEventAmountHistoryEntity } from '../../entity/ssg.event.amount.history.entity';
import { SsgEventRecoveryLogEntity } from '../../entity/ssg.event.recovery.log.entity';
import { SsgResendDeductRecoveryLogEntity } from '../../entity/ssg.resend.deduct.recovery.log.entity';
import { SsgResendDeductPendingEntity } from '../../entity/ssg.resend.deduct.pending.entity';
import { OrderDeliveryRefundEntity } from '../../entity/order.delivery.refund.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { IOrderType } from '../../order/interface/order.type';
import * as ExcelJS from 'exceljs';

import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { Transactional } from 'typeorm-transactional';
import { evaluateSsgEventSignals, SsgBalanceCheckResult, SsgEventSignalResult } from './ssg.balance.guard';
import { ulid } from 'ulid';
import { allocateSsgEventsForDeliveries, SsgAllocationIndeterminateError } from '../domain/ssg.event.allocation';
import {
  DeliveryCutoverGuardService,
  RefundExecutionFencing,
} from '../../delivery/application/delivery-cutover-guard.service';
import { LegacyDeliveryEntryPoint } from '../../delivery/interface/legacy.delivery.entry.point';

// 상세조회 임계경로에서 SSG 외부 API(getAmount) 지연이 페이지 로딩을 묶지 않도록 하는 가드 타임아웃
const SSG_BALANCE_CHECK_TIMEOUT_MS = 3000;

@Injectable()
export class SsgEventService {
  constructor(
    @InjectRepository(SsgEventEntity)
    private readonly ssgEventRepository: Repository<SsgEventEntity>,
    @InjectRepository(SsgEventAmountHistoryEntity)
    private readonly amountHistoryRepository: Repository<SsgEventAmountHistoryEntity>,
    @InjectRepository(OrderProductMappingEntity)
    private readonly orderProductMappingRepository: Repository<OrderProductMappingEntity>,
    @InjectRepository(SsgReservationRangeEntity)
    private readonly reservationRangeRepository: Repository<SsgReservationRangeEntity>,
    @InjectRepository(SsgEventRecoveryLogEntity)
    private readonly recoveryLogRepository: Repository<SsgEventRecoveryLogEntity>,
    @InjectRepository(SsgResendDeductRecoveryLogEntity)
    private readonly resendDeductRecoveryRepository: Repository<SsgResendDeductRecoveryLogEntity>,
    @InjectRepository(SsgResendDeductPendingEntity)
    private readonly resendDeductPendingRepository: Repository<SsgResendDeductPendingEntity>,
    @InjectRepository(OrderDeliveryRefundEntity)
    private readonly refundLedgerRepository: Repository<OrderDeliveryRefundEntity>,
    private readonly activityLogService: ActivityLogService,
    @Inject('ISsgIssue')
    private readonly ssgIssue: ISsgIssue,
    private readonly cutoverGuard: DeliveryCutoverGuardService,
  ) {}

  /**
   * 신세계 측 행사 금액 집계 실시간 조회 (GetSsgAmount.do).
   * ssg_event PK 로 엔티티를 로드해 no→event_no, order→event_seq 로 매핑한 뒤
   * 신세계 API 를 호출한다. (issue/check 와 동일 매핑)
   * @param id ssg_event PK
   * @returns 주문시도/발급성공/발급실패/미처리 금액
   */
  async getRemoteAmount(id: number): Promise<ISsgAmountResult> {
    const ssgEvent = await this.ssgEventRepository.findOne({ where: { id } });

    if (!ssgEvent) {
      throw new BadRequestException('존재하지 않는 이벤트입니다.');
    }

    return this.ssgIssue.getAmount({
      eventNo: ssgEvent.no,
      eventSeq: ssgEvent.order,
    });
  }

  /**
   * SSG 예약발송 가능 범위 조회 (단일 row 운용 - 가장 최신 1건만 사용)
   * @returns 설정된 range 또는 null (미설정 시 호출자가 폴백 처리)
   */
  async getReservationRange(): Promise<SsgReservationRangeEntity | null> {
    return await this.reservationRangeRepository.findOne({
      where: {},
      order: { id: 'DESC' },
    });
  }

  /**
   * SSG 예약발송 가능 범위 조회 (응답용 DTO)
   */
  async getReservationRangeView(): Promise<SsgReservationRangeViewResDto> {
    const range = await this.getReservationRange();
    return {
      startDate: range ? format(range.startDate, DateDateFormatStr) : null,
      endDate: range ? format(range.endDate, DateDateFormatStr) : null,
    };
  }

  /**
   * SSG 예약발송 가능 범위 갱신 (단일 row, 최고관리자 전용)
   */
  async updateReservationRange(startDateStr: string, endDateStr: string, userId: number): Promise<void> {
    const startDate = new Date(`${startDateStr}T00:00:00+09:00`);
    const endDate = new Date(`${endDateStr}T00:00:00+09:00`);

    if (endDate < startDate) {
      throw new BadRequestException('종료일은 시작일 이후여야 합니다.');
    }

    const existing = await this.getReservationRange();

    if (existing) {
      existing.startDate = startDate;
      existing.endDate = endDate;
      existing.updatedBy = userId;
      await this.reservationRangeRepository.save(existing);
    } else {
      await this.reservationRangeRepository.insert({
        startDate,
        endDate,
        updatedBy: userId,
      });
    }
  }

  /**
   * SSG 예약발송 가능 범위 해제 (단일 row, 최고관리자 전용)
   * 활성 row가 있으면 soft delete, 없으면 no-op (멱등)
   * 해제 후에는 폴백 정책(당월 말일까지)으로 동작
   */
  async deleteReservationRange(): Promise<void> {
    const existing = await this.getReservationRange();
    if (!existing) {
      return;
    }
    await this.reservationRangeRepository.softRemove(existing);
  }

  async getList(getQuery: SsgEventGetListReqDto): Promise<SsgEventGetListResDto> {
    const { take, page, code, createdEndAt, createdStartAt, name, searchKeyword } = getQuery;
    const skip = (page - 1) * take;

    const now = new Date();

    let queryBuilder = this.ssgEventRepository.createQueryBuilder('ssg');

    if (searchKeyword) {
      queryBuilder = queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('ssg.name LIKE :keyword', { keyword: `%${searchKeyword}%` }).orWhere('ssg.code LIKE :keyword', {
            keyword: `%${searchKeyword}%`,
          });
        }),
      );
    }

    if (code) {
      queryBuilder = queryBuilder.andWhere('ssg.code LIKE :code', { code: '%' + code + '%' });
    }

    if (name) {
      queryBuilder = queryBuilder.andWhere('ssg.name LIKE :name', { name: '%' + name + '%' });
    }

    // 조회기간 미설정 시 기본값: 이번 달 1일 이후까지 진행(종료)되는 행사 (상한 없음)
    if (!createdStartAt && !createdEndAt) {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      queryBuilder = queryBuilder.andWhere('ssg.endAt >= :monthStart', { monthStart });
    }

    // 조회기간: 행사기간(startAt~endAt)이 선택 기간과 겹치는 행사 필터 (등록일 기준 아님)
    queryBuilder = this.applyEventPeriodCondition(queryBuilder, createdStartAt, createdEndAt);

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

  /**
   * 조회기간(선택 기간)과 행사기간(startAt~endAt)이 겹치는 행사만 남기는 조건.
   * 등록일(createdAt)이 아니라 행사기간 기준으로 필터한다.
   * - 시작일 지정: 행사 종료일이 시작일 이상 (ssg.endAt >= start)
   * - 종료일 지정: 행사 시작일이 종료일 이하 (ssg.startAt <= end)
   */
  private applyEventPeriodCondition(
    queryBuilder: SelectQueryBuilder<SsgEventEntity>,
    createdStartAt?: string,
    createdEndAt?: string,
  ): SelectQueryBuilder<SsgEventEntity> {
    if (createdStartAt) {
      queryBuilder = queryBuilder.andWhere('ssg.endAt >= :eventPeriodStart', {
        eventPeriodStart: createdStartAt.replace('T', ' '),
      });
    }

    if (createdEndAt) {
      queryBuilder = queryBuilder.andWhere('ssg.startAt <= :eventPeriodEnd', {
        eventPeriodEnd: createdEndAt.replace('T', ' '),
      });
    }

    return queryBuilder;
  }

  async excelDownload(user: ILoginUserInfo, getBody: SsgEventExcelDownloadReqDto) {
    const startTime = Date.now();
    const { code, createdEndAt, createdStartAt, name, password, downloadReason, searchKeyword } = getBody;

    // 비밀번호 검증
    await this.activityLogService.verifyPassword(user.id, password);

    const now = new Date();
    const nowString = format(now, 'yyyyMMdd');

    let queryBuilder = this.ssgEventRepository.createQueryBuilder('ssg');

    if (searchKeyword) {
      queryBuilder = queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('ssg.name LIKE :keyword', { keyword: `%${searchKeyword}%` }).orWhere('ssg.code LIKE :keyword', {
            keyword: `%${searchKeyword}%`,
          });
        }),
      );
    }

    if (code) {
      queryBuilder = queryBuilder.andWhere('ssg.code LIKE :code', { code: '%' + code + '%' });
    }

    if (name) {
      queryBuilder = queryBuilder.andWhere('ssg.name LIKE :name', { name: '%' + name + '%' });
    }

    // 조회기간: 행사기간(startAt~endAt)이 선택 기간과 겹치는 행사 필터 (등록일 기준 아님)
    queryBuilder = this.applyEventPeriodCondition(queryBuilder, createdStartAt, createdEndAt);

    const eventList = await queryBuilder.getMany();

    const ssgEventIdList = eventList.map((event) => event.id);

    // 검색 결과가 0건이면 IN () 쿼리 에러 방지
    const orderProductMappingList =
      ssgEventIdList.length > 0
        ? await this.orderProductMappingRepository
            .createQueryBuilder('orderProductMapping')
            .innerJoinAndSelect('orderProductMapping.product', 'product')
            .innerJoinAndSelect('orderProductMapping.order', 'order')
            .innerJoinAndSelect('orderProductMapping.orderDeliveries', 'orderDeliveries')
            .where('orderDeliveries.ssgEventId IN (:...ssgEventIdList)', { ssgEventIdList })
            .andWhere('order.type = :type', { type: IOrderType.SSG })
            .getMany()
        : [];

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
    const filePath = createExportTempPath('xlsx');

    await workbook.xlsx.writeFile(filePath);

    // 성공 로그 저장
    const responseTime = Date.now() - startTime;
    const recordCount = resultList.length;
    const requestParams: Record<string, unknown> = { ...getBody };
    delete requestParams.password;

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

    if (!Number.isInteger(eventPrice) || eventPrice < 1) {
      throw new BadRequestException('행사 금액은 1원 이상의 정수여야 합니다.');
    }

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
  }

  /**
   * SSG 행사 잔액 관리 — 비관적 락으로 단일 행 조회.
   *
   * 반드시 @Transactional() (Propagation.REQUIRED 기본) 데코레이터가 적용된
   * 메서드 안에서만 호출해야 한다. 락은 호출 측 트랜잭션 종료 시 해제된다.
   * typeorm-transactional 컨텍스트 외부에서 호출하면 락이 무의미해진다.
   */
  private async findSsgEventForUpdate(id: number): Promise<SsgEventEntity | null> {
    return this.ssgEventRepository
      .createQueryBuilder('ssg')
      .setLock('pessimistic_write')
      .where('ssg.id = :id', { id })
      .getOne();
  }

  /**
   * 여러 행사를 id 오름차순 단일 쿼리로 한 번에 잠근다.
   * 서로 다른 트랜잭션이 같은 행사 집합을 다루더라도 항상 동일한(id ASC) 순서로
   * 락을 획득하도록 강제해 데드락을 방지한다. 반드시 @Transactional() 컨텍스트에서 호출.
   */
  private async lockEventsForUpdate(ids: number[]): Promise<void> {
    const uniqueIds = [...new Set(ids)].sort((a, b) => a - b);
    if (uniqueIds.length === 0) {
      return;
    }
    await this.ssgEventRepository
      .createQueryBuilder('ssg')
      .setLock('pessimistic_write')
      .where('ssg.id IN (:...uniqueIds)', { uniqueIds })
      .orderBy('ssg.id', 'ASC')
      .getMany();
  }

  @Transactional()
  async updateAmount(getBody: SsgEventUpdateAmountReqDto) {
    const { id, amount } = getBody;

    if (!Number.isInteger(amount) || amount < 1) {
      throw new BadRequestException('충전 금액은 1원 이상의 정수여야 합니다.');
    }

    const ssgEvent = await this.findSsgEventForUpdate(id);

    if (!ssgEvent) {
      throw new BadRequestException('존재하지 않는 이벤트입니다.');
    }

    const newBalance = ssgEvent.eventBalance + amount;

    const ssgEventAmountHistory = this.amountHistoryRepository.create({
      ssgEventId: ssgEvent.id,
      amount: amount,
      balance: newBalance,
    });
    ssgEvent.eventPrice += amount;
    ssgEvent.eventBalance = newBalance;
    await this.amountHistoryRepository.save(ssgEventAmountHistory);
    await this.ssgEventRepository.save(ssgEvent);
  }

  async getValidList(getQuery: SsgEventGetValidListReqDto): Promise<SsgEventGetValidListResDto> {
    const { couponExpiration, reserveDate } = getQuery;
    const referenceDate = reserveDate ? new Date(`${reserveDate}T00:00:00+09:00`) : new Date();

    let queryBuilder = this.ssgEventRepository
      .createQueryBuilder('ssg')
      .where('ssg.startAt <= :referenceDate', { referenceDate })
      .andWhere('ssg.endAt >= :referenceDate', { referenceDate })
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

  async selectEventForOrder(
    orderAmount: number,
    couponExpiration?: number,
    reserveDate?: Date,
  ): Promise<SsgEventEntity | null> {
    const referenceDate = reserveDate ?? new Date();

    let queryBuilder = this.ssgEventRepository
      .createQueryBuilder('ssg')
      .where('ssg.startAt <= :referenceDate', { referenceDate })
      .andWhere('ssg.endAt >= :referenceDate', { referenceDate })
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
   *
   * 배송건마다 reserveDate가 다를 수 있으므로(상품별 예약시각), 각 배송건은 자신의
   * 예약시각(reserveDate) 기준으로 유효한 행사에만 매칭한다. reserveDate가 없으면
   * defaultReserveDate → 현재 시각 순으로 폴백한다. 후보 집합이 배송건마다 달라
   * first-fit이 실행 가능한 조합을 놓칠 수 있으므로, 정확한 할당 탐색은
   * allocateSsgEventsForDeliveries(순수 함수)에 위임한다.
   * @param deliveries 배송건 정보 배열 [{ deliveryId, price, reserveDate? }]
   * @param couponExpiration 쿠폰 유효기간
   * @param defaultReserveDate reserveDate가 없는 배송건에 적용할 기준 시각(폴백)
   * @returns 할당 결과 배열 [{ deliveryId, eventId, price }] 또는 null (잔액 부족)
   */
  async allocateEventsForDeliveries(
    deliveries: { deliveryId: number; price: number; reserveDate?: Date }[],
    couponExpiration?: number,
    defaultReserveDate?: Date,
  ): Promise<{ deliveryId: number; eventId: number; price: number }[] | null> {
    // 후보 행사 조회(잔액 > 0). 유효기간(startAt~endAt) 매칭은 배송건별 기준시각으로 판정하므로
    // 날짜 조건은 쿼리에 걸지 않고 할당 로직에서 처리한다.
    let queryBuilder = this.ssgEventRepository
      .createQueryBuilder('ssg')
      .where('ssg.eventBalance > 0')
      .orderBy('ssg.id', 'ASC');

    if (couponExpiration) {
      queryBuilder = queryBuilder.andWhere('ssg.couponExpiration = :couponExpiration', { couponExpiration });
    }

    const events = await queryBuilder.getMany();

    try {
      return allocateSsgEventsForDeliveries(events, deliveries, defaultReserveDate);
    } catch (error) {
      // 탐색 한도 초과(결정 불가)는 "잔액 부족(null)"과 구분되는 서버측 오류로 처리한다.
      if (error instanceof SsgAllocationIndeterminateError) {
        throw new InternalServerErrorException(
          'SSG 행사 자동 할당 계산이 지연되어 완료하지 못했습니다. 주문 수량을 줄이거나 나누어 다시 시도해주세요.',
        );
      }
      throw error;
    }
  }

  /**
   * 여러 행사에서 분할 차감합니다.
   * @param allocations 할당 정보 배열 [{ deliveryId, eventId, price }]
   * @param orderId 주문 ID
   * @param isTemporary 가차감 여부
   */
  @Transactional()
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
    // eventId 오름차순으로 락 획득 순서를 결정화하여 데드락 방지
    // (호출자가 임의 순서로 allocations를 만들어도 안전)
    const sortedDeductions = [...eventDeductions.entries()].sort(([a], [b]) => a - b);
    for (const [eventId, totalAmount] of sortedDeductions) {
      const ssgEvent = await this.findSsgEventForUpdate(eventId);

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

  @Transactional()
  async deductEventBalance(
    eventId: number,
    amount: number,
    orderId: number,
    isTemporary: boolean = true,
  ): Promise<void> {
    const ssgEvent = await this.findSsgEventForUpdate(eventId);

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

  @Transactional()
  async restoreEventBalance(orderId: number): Promise<void> {
    // 주문 취소 복원은 같은 주문의 사후 보정 이력(실패환불/재발송 재차감/역복원)을 다시 뒤집지 않고,
    // 행사별 NET 이 아직 음수인 경우에만 남은 점유액을 복원한다.
    const initialHistories = await this.amountHistoryRepository.find({
      where: { orderId },
      order: { ssgEventId: 'ASC' },
    });

    // ssgEventId 오름차순으로 락 획득 순서를 결정화하여 데드락 방지
    // (동일 주문이 다중 행사를 갖고 동시에 cancel/refund되는 경우 대비)
    const eventIds = [
      ...new Set(initialHistories.map((history) => history.ssgEventId).filter((id): id is number => !!id)),
    ].sort((a, b) => a - b);
    for (const ssgEventId of eventIds) {
      const ssgEvent = await this.findSsgEventForUpdate(ssgEventId);

      if (!ssgEvent) {
        continue;
      }

      // 동시 취소/복원 대기 후에는 앞선 트랜잭션의 복원 이력이 생겼을 수 있으므로 lock 이후 최신 NET을 다시 계산한다.
      const latestHistories = await this.amountHistoryRepository.find({
        where: { orderId, ssgEventId },
      });
      const netAmount = latestHistories.reduce((sum, history) => sum + (history.amount ?? 0), 0);
      if (netAmount >= 0) {
        continue;
      }

      const restoreAmount = -netAmount;
      const restoredBalance = ssgEvent.eventBalance + restoreAmount;

      const restorationHistory = this.amountHistoryRepository.create({
        ssgEventId: ssgEvent.id,
        amount: restoreAmount,
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

  async hasOpenTempDeduction(orderId: number): Promise<boolean> {
    const count = await this.amountHistoryRepository.count({
      where: { orderId, isTemporary: true, amount: LessThan(0) },
    });
    return count > 0;
  }

  /** 특정 주문의 미확정(isTemporary=true) 가차감이 걸려있는 행사 id 목록. */
  private async getOpenTempDeductionEventIds(orderId: number): Promise<number[]> {
    const histories = await this.amountHistoryRepository.find({
      where: { orderId, isTemporary: true, amount: LessThan(0) },
    });
    return histories.map((h) => h.ssgEventId).filter((id): id is number => !!id);
  }

  /** 특정 유효기간(couponExpiration)의 잔액 있는 후보 행사 id 목록. */
  private async getCandidateEventIdsByExpiration(couponExpiration: number): Promise<number[]> {
    const events = await this.ssgEventRepository
      .createQueryBuilder('ssg')
      .select('ssg.id')
      .where('ssg.eventBalance > 0')
      .andWhere('ssg.couponExpiration = :couponExpiration', { couponExpiration })
      .getMany();
    return events.map((e) => e.id);
  }

  /**
   * 유효기간 변경(ssgCouponExpireChange) 시작 시 restore 대상(기존 이벤트)과
   * allocate 후보(새 유효기간 이벤트)를 하나의 id ASC 순서로 선잠금한다.
   * restore/allocate가 각자 다른 순서로 개별 락을 잡는 경합(데드락 소지)을 원천 차단.
   */
  @Transactional()
  async lockEventsForCouponExpireChange(orderId: number, couponExpiration: number): Promise<void> {
    const [openIds, candidateIds] = await Promise.all([
      this.getOpenTempDeductionEventIds(orderId),
      this.getCandidateEventIdsByExpiration(couponExpiration),
    ]);
    await this.lockEventsForUpdate([...openIds, ...candidateIds]);
  }

  @Transactional()
  async restoreTemporaryEventBalance(orderId: number): Promise<void> {
    const histories = await this.amountHistoryRepository.find({
      where: { orderId, isTemporary: true },
      order: { ssgEventId: 'ASC' },
    });

    for (const history of histories) {
      if (!history.ssgEventId || history.amount == null || history.amount >= 0) {
        continue;
      }

      const ssgEvent = await this.findSsgEventForUpdate(history.ssgEventId);

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
      await this.amountHistoryRepository.update({ id: history.id }, { isTemporary: false });
      await this.ssgEventRepository.save(ssgEvent);
    }
  }

  async getOpenTempDeductionByEvent(ssgEventId: number): Promise<number> {
    // R = '아직 살아있는' 검토중 선차감의 NET 합.
    //
    // (isTemporary=true AND amount<0) 만 gross 로 합산하면 안 된다.
    // 발송확정 전(검토완료/주문완료) SSG 주문이 취소되면 restoreEventBalance 가 복원분을
    // 별도 row(+금액, isTemporary=false)로 적재하고 원본 음수 차감 row(isTemporary=true)는 그대로 남긴다.
    // → gross 합산은 이미 복원(취소)된 차감까지 영구 누적해 R 이 부풀고,
    //    rho(=Bal-P+R+S+F+Pend)가 실제보다 커져 A2(과다환불) 가짜경보가 난다.
    //
    // 그래서 주문 단위 NET(전체 row 합)을 내고, '미확정 음수 차감을 보유'하면서 'NET 이 여전히 음수'인
    // 주문만 살아있는 선차감으로 본다.
    //  - 검토중 주문: 음수 차감만 존재 → NET<0 → 포함.
    //  - 취소(복원)된 주문: 음수(true) + 복원분(+, false) → NET=0 → 제외.
    //  - 확정 주문: 차감 row 가 isTemporary=false 로 flip → 음수 temp 보유조건 불충족 → 제외.
    //  - 충전 row: orderId NULL → 제외.
    const rows = await this.amountHistoryRepository
      .createQueryBuilder('h')
      .select('COALESCE(SUM(h.amount), 0)', 'net')
      .where('h.ssgEventId = :ssgEventId', { ssgEventId })
      .andWhere('h.orderId IS NOT NULL')
      .groupBy('h.orderId')
      .having('SUM(CASE WHEN h.isTemporary = :t AND h.amount < 0 THEN 1 ELSE 0 END) > 0 AND SUM(h.amount) < 0', {
        t: true,
      })
      .getRawMany<{ net: string }>();

    const net = rows.reduce((acc, row) => acc + Number(row.net ?? 0), 0);
    return Math.abs(net);
  }

  /**
   * 발송확정 전 SSG 주문의 행사잔액 이상 탐지(읽기전용).
   * 이 주문이 발송요청 당시 차감한(미확정) 이력을 행사별로 모아 A_E 를 구하고,
   * 행사별 신세계 live 집계(GetSsgAmount.do)·우리 잔액·R 을 모아 신호를 판정한다.
   * SSG 주문 차감이력이 없으면 null. SSG live 조회 실패는 lookupFailed=true 로 보고하고
   * 예외를 전파하지 않는다(상세조회를 깨지 않기 위함).
   */
  async getSsgBalanceCheckForOrder(orderId: number): Promise<SsgBalanceCheckResult | null> {
    // 1. 이 주문의 미확정 차감 이력을 행사별로 그룹화 → A_E (발송요청 당시 차감 기준, live 정가 아님)
    const groups = await this.amountHistoryRepository
      .createQueryBuilder('h')
      .select('h.ssgEventId', 'ssgEventId')
      .addSelect('COALESCE(SUM(h.amount), 0)', 'sum')
      .where('h.orderId = :orderId', { orderId })
      .andWhere('h.isTemporary = :t', { t: true })
      .andWhere('h.amount < 0')
      .groupBy('h.ssgEventId')
      .getRawMany<{ ssgEventId: number; sum: string }>();

    if (groups.length === 0) {
      return null;
    }

    // 2. 행사별 판정을 병렬 실행(임계경로 차단 최소화). 다행사 주문이어도 외부 API 직렬 대기 안 함.
    const results = await Promise.all(groups.map((group) => this.evaluateEventGroup(group)));

    const events = results.flatMap((r) => (r.event ? [r.event] : []));
    const lookupFailed = results.some((r) => r.lookupFailed);

    return {
      hasWarning: events.some((e) => e.hasWarning),
      lookupFailed,
      events,
    };
  }

  /**
   * 행사 1건 판정. SSG live 조회 실패/타임아웃은 lookupFailed 로 보고하고 예외를 전파하지 않는다.
   * 차감이력은 있는데 행사가 사라진 내부 불일치도 누락을 숨기지 않도록 lookupFailed 로 보고한다.
   */
  private async evaluateEventGroup(group: {
    ssgEventId: number;
    sum: string;
  }): Promise<{ event: SsgEventSignalResult | null; lookupFailed: boolean }> {
    // 임계경로 완전차단 방지(#1 취지). 외부 API 타임아웃뿐 아니라 DB 조회 실패까지 모두
    // lookupFailed 로 흡수해 상세조회가 깨지지 않게 한다.
    try {
      const { ssgEventId } = group;
      const orderAmount = Math.abs(Number(group.sum ?? 0));

      const event = await this.ssgEventRepository.findOne({ where: { id: ssgEventId } });
      if (!event) {
        return { event: null, lookupFailed: true };
      }

      const amount = await this.withTimeout(
        this.ssgIssue.getAmount({ eventNo: event.no, eventSeq: event.order }),
        SSG_BALANCE_CHECK_TIMEOUT_MS,
      );

      const openTempDeduction = await this.getOpenTempDeductionByEvent(ssgEventId);

      return {
        event: evaluateSsgEventSignals({
          ssgEventId,
          eventName: event.name,
          eventBalance: event.eventBalance,
          eventPrice: event.eventPrice,
          successAmt: amount.successAmt,
          failAmt: amount.failAmt,
          pendingAmt: amount.pendingAmt,
          openTempDeduction,
          orderAmount,
          tol: 0,
        }),
        lookupFailed: false,
      };
    } catch {
      return { event: null, lookupFailed: true };
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SSG getAmount timeout')), ms);
      timer.unref?.();
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  /**
   * 개별 배송건 PIN 발급 실패 시 해당 금액만 환불 (멱등).
   *
   * 멱등 보장: 환불 ledger row id(refund_ledger_id) 를 키로 ssg_event_recovery_log 에 INSERT.
   * UNIQUE 제약(uk_ssg_event_recovery_ledger) 으로 동일 ledger 의 두 번째 복구를 차단한다.
   * - ssgEvent 없음 → throw (silent return 금지). rollback 으로 멱등키 미소비 → 재시도 가능.
   * - ledger row 없음 → throw. claim 없이 호출된 비정상 흐름.
   * - INSERT ER_DUP_ENTRY → 이미 복구됨. 잔액 미변경 return (멱등).
   *
   * @param ssgEventId SSG 이벤트 ID
   * @param orderId 주문 ID
   * @param amount 환불할 금액 (상품 가격)
   * @param orderDeliveryId 환불 ledger 조회용 발송건 ID (멱등키 도출, fallback)
   * @param refundLedgerId 멱등키로 쓸 환불 ledger row id. lease 경유(지연 가능) 호출은
   *   claim 시점에 token-fenced 로 읽은 id 를 **명시 전달**해야 한다. 미전달 시 orderDeliveryId 로 현재 row 재조회.
   */
  @Transactional()
  async refundForDeliveryFail(
    ssgEventId: number,
    orderId: number,
    amount: number,
    orderDeliveryId: number,
    refundLedgerId?: number,
    refundExecution?: RefundExecutionFencing,
  ): Promise<void> {
    if (refundExecution) {
      await this.cutoverGuard.assertRefundExecutionAllowed({
        orderDeliveryId,
        fencing: refundExecution,
        entryPoint: LegacyDeliveryEntryPoint.SSG_EVENT_REFUND,
      });
    } else {
      await this.cutoverGuard.assertLegacyAllowed(orderDeliveryId, LegacyDeliveryEntryPoint.SSG_EVENT_REFUND);
    }

    const ssgEvent = await this.findSsgEventForUpdate(ssgEventId);

    if (!ssgEvent) {
      throw new InternalServerErrorException(
        `SSG 이벤트를 찾을 수 없어 행사 잔액 복구 실패 (ssgEventId: ${ssgEventId}, orderDeliveryId: ${orderDeliveryId})`,
      );
    }

    // 멱등키 = 환불 ledger row id.
    //  - 명시 전달(lease 경유, 지연 가능): claim 시점 id 사용 → 재조회로 인한 cross-cycle 멱등키 오염 차단.
    //    (지연된 이전 cycle 이 release+재INSERT 된 새 ledger 의 키를 소비해 새 cycle 복구를 막는 race 방지.)
    //  - 미전달(동기 호출: claim→resolve 원자, 지연 없음): 현재 row 재조회 (race 없음).
    let ledgerId: number;
    if (refundLedgerId != null) {
      ledgerId = refundLedgerId;
    } else {
      const ledger = await this.refundLedgerRepository.findOne({
        where: { orderDeliveryId },
        select: ['id'],
      });
      if (!ledger) {
        throw new InternalServerErrorException(
          `환불 ledger 가 없어 행사 잔액 복구 멱등키를 만들 수 없음 (orderDeliveryId: ${orderDeliveryId})`,
        );
      }
      ledgerId = ledger.id;
    }

    try {
      await this.recoveryLogRepository
        .createQueryBuilder()
        .insert()
        .into(SsgEventRecoveryLogEntity)
        .values({
          refundLedgerId: ledgerId,
          ssgEventId: ssgEvent.id,
          orderId,
          amount,
        })
        .execute();
    } catch (e: any) {
      if (e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062) {
        // 이미 복구됨 — 잔액 미변경 (멱등).
        return;
      }
      throw e;
    }

    await this.applyEventBalanceRestore(ssgEvent, amount, orderId);
  }

  /**
   * 재발송 새 행사 선차감(deductEventBalance) 역복원 — 전용 멱등 단위.
   *
   * 원래 발송 실패 환불(refundForDeliveryFail, refund_ledger_id 키)과 별개 deduction 이므로
   * 같은 ledger 키를 재사용하면 기존 recovery_log 와 충돌해 실제 복원이 no-op 되는 leak 이 발생한다(HIGH).
   * 따라서 재발송 선차감마다 발급한 고유 resendDeductionId 를 멱등키(ssg_resend_deduct_recovery UNIQUE)로 사용한다.
   * INSERT 가 ER_DUP_ENTRY 면 이미 역복원됨 → 잔액 미변경 return(멱등).
   *
   * orphan/state 분기는 caller(resolver)가 담당 — 이 메서드는 잔액 역복원만.
   */
  @Transactional()
  async refundResendEventDeduction(input: {
    resendDeductionId: string;
    ssgEventId: number;
    orderId: number;
    amount: number;
    /**
     * 역복원 대상 발송건(§9 인벤토리 #9 컷오버 판정용). 알 수 있는 호출자만 넘긴다.
     *
     * 선차감 unwind 는 **발송건이 아직 확정되지 않은 구간**(issue 미시도 직접 역복원·sweep 재시도)에서도
     * 일어난다. 그 구간에는 귀속시킬 `order_delivery` 가 없어 컷오버 판정 자체가 성립하지 않으므로
     * 값을 넘기지 않으며, 그때는 이 원장 조작이 legacy/신규 경로 구분과 무관하다.
     */
    orderDeliveryId?: number;
  }): Promise<void> {
    if (input.orderDeliveryId != null) {
      await this.cutoverGuard.assertLegacyAllowed(input.orderDeliveryId, LegacyDeliveryEntryPoint.SSG_EVENT_REFUND);
    }

    const ssgEvent = await this.findSsgEventForUpdate(input.ssgEventId);

    if (!ssgEvent) {
      throw new InternalServerErrorException(
        `SSG 이벤트를 찾을 수 없어 재발송 선차감 역복원 실패 (ssgEventId: ${input.ssgEventId}, resendDeductionId: ${input.resendDeductionId})`,
      );
    }

    try {
      await this.resendDeductRecoveryRepository
        .createQueryBuilder()
        .insert()
        .into(SsgResendDeductRecoveryLogEntity)
        .values({
          resendDeductionId: input.resendDeductionId,
          ssgEventId: ssgEvent.id,
          orderId: input.orderId,
          amount: input.amount,
        })
        .execute();
    } catch (e: any) {
      if (e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062) {
        // 이미 역복원됨 — 잔액 미변경 (멱등).
        return;
      }
      throw e;
    }

    await this.applyEventBalanceRestore(ssgEvent, input.amount, input.orderId);
  }

  /**
   * 행사 잔액 += amount + amount_history 기록. 멱등 가드는 caller 가 수행(여기선 순수 적용).
   */
  private async applyEventBalanceRestore(ssgEvent: SsgEventEntity, amount: number, orderId: number): Promise<void> {
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
  @Transactional()
  async chargeBackForResend(ssgEventId: number, orderId: number, amount: number): Promise<void> {
    const ssgEvent = await this.findSsgEventForUpdate(ssgEventId);

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

  /**
   * 재발급 선차감 + durable pending INSERT 를 **한 트랜잭션**으로 원자 처리 (crash window W1 차단).
   *
   * 모든 재발급 선차감 경로(배치 재발송 / CS 폐기후신규)는 deductEventBalance 를 직접 호출하지 말고
   * 반드시 이 메서드만 사용한다. 선차감만 커밋되고 pending 이 안 남는 구간이 존재하면 크래시 시 leak 복구 단서가 사라진다.
   *
   * @returns resendDeductionId — 이후 markReissueIssueAttempted / resolveReissuePending /
   *   refundResendEventDeduction 의 멱등키.
   */
  @Transactional()
  async deductForReissueWithPending(input: {
    ssgEventId: number;
    amount: number;
    orderId: number;
    purpose: 'BATCH_RESEND' | 'CS_REISSUE';
    issueOrderDeliveryId: number | null;
  }): Promise<{ resendDeductionId: string }> {
    const ssgEvent = await this.findSsgEventForUpdate(input.ssgEventId);

    if (!ssgEvent) {
      throw new BadRequestException('유효한 이벤트가 없습니다.');
    }

    if (ssgEvent.eventBalance < input.amount) {
      throw new BadRequestException('이벤트 잔액이 부족합니다.');
    }

    const { resendDeductionId } = await this.applyReissueDeductionWithPending(ssgEvent, input);
    return { resendDeductionId };
  }

  /**
   * 재발급용 행사 후보를 같은 트랜잭션에서 잠근 뒤 차감+pending을 원자 처리한다.
   * 선택 시점과 차감 시점 사이에 첫 후보가 소진되더라도, 잠긴 최신 잔액 기준으로 다음 후보를 사용한다.
   */
  @Transactional()
  async selectAndDeductForReissueWithPending(input: {
    amount: number;
    orderId: number;
    couponExpiration?: number;
    purpose: 'BATCH_RESEND' | 'CS_REISSUE';
    issueOrderDeliveryId: number | null;
  }): Promise<{ event: SsgEventEntity; resendDeductionId: string } | null> {
    const referenceDate = new Date();
    let queryBuilder = this.ssgEventRepository
      .createQueryBuilder('ssg')
      .setLock('pessimistic_write')
      .where('ssg.startAt <= :referenceDate', { referenceDate })
      .andWhere('ssg.endAt >= :referenceDate', { referenceDate })
      .andWhere('ssg.eventBalance > 0')
      .orderBy('ssg.id', 'ASC');

    if (input.couponExpiration) {
      queryBuilder = queryBuilder.andWhere('ssg.couponExpiration = :couponExpiration', {
        couponExpiration: input.couponExpiration,
      });
    }

    const candidates = await queryBuilder.getMany();
    for (const event of candidates) {
      if (event.eventBalance < input.amount) {
        continue;
      }

      const { resendDeductionId } = await this.applyReissueDeductionWithPending(event, {
        ssgEventId: event.id,
        amount: input.amount,
        orderId: input.orderId,
        purpose: input.purpose,
        issueOrderDeliveryId: input.issueOrderDeliveryId,
      });
      return { event, resendDeductionId };
    }

    return null;
  }

  private async applyReissueDeductionWithPending(
    ssgEvent: SsgEventEntity,
    input: {
      ssgEventId: number;
      amount: number;
      orderId: number;
      purpose: 'BATCH_RESEND' | 'CS_REISSUE';
      issueOrderDeliveryId: number | null;
    },
  ): Promise<{ resendDeductionId: string }> {
    const newBalance = ssgEvent.eventBalance - input.amount;

    const history = this.amountHistoryRepository.create({
      ssgEventId: ssgEvent.id,
      amount: -input.amount,
      balance: newBalance,
      orderId: input.orderId,
      isTemporary: false,
    });

    ssgEvent.eventBalance = newBalance;
    await this.amountHistoryRepository.save(history);
    await this.ssgEventRepository.save(ssgEvent);

    const resendDeductionId = ulid();
    await this.resendDeductPendingRepository.save(
      this.resendDeductPendingRepository.create({
        resendDeductionId,
        ssgEventId: input.ssgEventId,
        orderId: input.orderId,
        amount: input.amount,
        purpose: input.purpose,
        issueOrderDeliveryId: input.issueOrderDeliveryId,
      }),
    );

    return { resendDeductionId };
  }

  /**
   * issue() 직전 호출 — pending 에 실제 issue 대상 delivery id 와 시도 시각을 기록한다.
   * issue_order_delivery_id 는 최초 1회만 고정(COALESCE) — 이후 재호출에도 안전.
   * 이 마킹이 있어야 sweep 이 W1(미시도 → 직접 역복원)과 issue 시도(state 기준 확정)를 구분한다.
   */
  async markReissueIssueAttempted(resendDeductionId: string, issueOrderDeliveryId: number): Promise<void> {
    await this.resendDeductPendingRepository
      .createQueryBuilder()
      .update(SsgResendDeductPendingEntity)
      .set({
        issueOrderDeliveryId: () => `COALESCE(issue_order_delivery_id, ${issueOrderDeliveryId})`,
        issueAttemptedAt: () => 'NOW(6)',
      })
      .where('resend_deduction_id = :rid', { rid: resendDeductionId })
      .andWhere('resolved_at IS NULL')
      .execute();
  }

  /**
   * 재발급 선차감 pending 해소(KEPT=차감 유지 / REVERSED=역복원). resolved_at IS NULL 일 때만 1회.
   * 해소된 row 는 sweep 후보에서 제외된다.
   */
  async resolveReissuePending(resendDeductionId: string, resolution: 'KEPT' | 'REVERSED'): Promise<void> {
    await this.resendDeductPendingRepository
      .createQueryBuilder()
      .update(SsgResendDeductPendingEntity)
      .set({ resolvedAt: () => 'NOW(6)', resolution })
      .where('resend_deduction_id = :rid', { rid: resendDeductionId })
      .andWhere('resolved_at IS NULL')
      .execute();
  }
}
