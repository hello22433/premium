import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, EntityManager, In, LessThan, Not, Repository } from 'typeorm';
import { ActivityLogEntity } from '../../entity/activity.log.entity';
import { ActivityLogResult } from '../interface/activity.log.result';
import { UserEntity } from '../../entity/user.entity';
import { PasswordBcryptEncrypt } from '../../auth/infrastructure/password.bcrypt.encrypt';
import { GetActivityLogListReqDto, DownloadActivityLogExcelReqDto } from '../api/activity.log.req.dto';
import { GetActivityLogListResDto, GetActionTypesResDto, ActivityLogViewDto } from '../api/activity.log.res.dto';
import { format, subMonths } from 'date-fns';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { MaskingUtil } from '../../common/utils/masking.util';
import { IReportHistoryType, IReportSource } from '../../order/interface/report.source';
import {
  ACTIVITY_LOG_RETENTION_MONTHS,
  ACTIVITY_LOG_PURGE_EXCLUDED_ACTION_TYPES,
} from '../interface/activity.log.retention';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';

export type CreateActivityLogDto = {
  userId: number;
  userEmail: string;
  method: string;
  requestUrl: string;
  actionType: string;
  ipAddress: string;
  userAgent?: string;
  statusCode: number;
  result: ActivityLogResult;
  responseTime: number;
  downloadReason?: string;
  recordCount?: number;
  requestParams?: any;
  errorMessage?: string;
};

@Injectable()
export class ActivityLogService {
  constructor(
    @InjectRepository(ActivityLogEntity)
    private activityLogRepository: Repository<ActivityLogEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private passwordBcryptEncrypt: PasswordBcryptEncrypt,
  ) {}

  /**
   * 활동 로그 생성.
   * 생성된 로그 id 를 반환한다 (wallet mirror idempotency_key 생성 등에서 사용).
   * 호출 트랜잭션이 @Transactional cls 컨텍스트면 같은 트랜잭션 안에서 INSERT 된다.
   */
  async createLog(dto: CreateActivityLogDto, manager?: EntityManager): Promise<number> {
    // manager 전달 시 해당 트랜잭션 안에서 INSERT(동일 트랜잭션 감사 보장). 미전달 시 전역 repository.
    const repo = manager ? manager.getRepository(ActivityLogEntity) : this.activityLogRepository;
    const result = await repo.insert({
      userId: dto.userId,
      userEmail: dto.userEmail,
      method: dto.method,
      requestUrl: dto.requestUrl,
      actionType: dto.actionType,
      ipAddress: dto.ipAddress,
      userAgent: dto.userAgent || null,
      statusCode: dto.statusCode,
      result: dto.result,
      responseTime: dto.responseTime,
      downloadReason: dto.downloadReason || null,
      recordCount: dto.recordCount || null,
      requestParams: MaskingUtil.maskActivityLogParams(dto.requestParams) as any,
      errorMessage: dto.errorMessage || null,
    });
    return Number(result.identifiers[0].id);
  }

  /**
   * 보존기간(24개월) 초과 로그 purge. 정산/감사/계정 라이프사이클 actionType 은 제외(장기 보존).
   * 일 1회 cron 에서 호출. hard delete.
   * @returns 삭제 건수
   */
  async purgeOldLogs(): Promise<number> {
    const cutoff = subMonths(new Date(), ACTIVITY_LOG_RETENTION_MONTHS);
    const result = await this.activityLogRepository.delete({
      createdAt: LessThan(cutoff),
      actionType: Not(In(ACTIVITY_LOG_PURGE_EXCLUDED_ACTION_TYPES)),
    });
    return result.affected ?? 0;
  }

  /**
   * 비밀번호 확인
   * @param userId 사용자 ID
   * @param password 입력받은 비밀번호
   * @throws UnauthorizedException 비밀번호가 일치하지 않는 경우
   */
  async verifyPassword(userId: number, password: string): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new BadRequestException('사용자를 찾을 수 없습니다.');
    }

    const isPasswordValid = await this.passwordBcryptEncrypt.compare(password, user.password);

    if (!isPasswordValid) {
      throw new BadRequestException('비밀번호가 일치하지 않습니다.');
    }
  }

  /**
   * 활동 로그 목록 조회
   */
  async getActivityLogList(dto: GetActivityLogListReqDto): Promise<GetActivityLogListResDto> {
    const { startAt, endAt, actionType, searchKeyword, page, take } = dto;

    const queryBuilder = this.activityLogRepository
      .createQueryBuilder('activityLog')
      .where('activityLog.deletedAt IS NULL');

    // 기간 검색
    if (startAt) {
      queryBuilder.andWhere('activityLog.createdAt >= :startAt', { startAt: `${startAt} 00:00:00` });
    }
    if (endAt) {
      queryBuilder.andWhere('activityLog.createdAt <= :endAt', { endAt: `${endAt} 23:59:59` });
    }

    // 액션 타입 검색
    if (actionType) {
      queryBuilder.andWhere('activityLog.actionType = :actionType', { actionType });
    }

    // 검색어 (IP 주소 또는 이메일)
    if (searchKeyword) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('activityLog.ipAddress LIKE :searchKeyword', { searchKeyword: `%${searchKeyword}%` }).orWhere(
            'activityLog.userEmail LIKE :searchKeyword',
            { searchKeyword: `%${searchKeyword}%` },
          );
        }),
      );
    }

    // 페이징
    const skip = (page - 1) * take;
    queryBuilder.orderBy('activityLog.createdAt', 'DESC').skip(skip).take(take);

    const [logs, totalCount] = await queryBuilder.getManyAndCount();

    const list: ActivityLogViewDto[] = logs.map((log) => ({
      id: log.id,
      createdAt: format(log.createdAt, DateFormatStr),
      userEmail: log.userEmail,
      method: log.method,
      requestUrl: log.requestUrl,
      actionType: log.actionType,
      ipAddress: log.ipAddress,
      userAgent: log.userAgent,
      statusCode: log.statusCode,
      result: log.result,
      responseTime: log.responseTime,
      downloadReason: log.downloadReason,
      recordCount: log.recordCount,
      requestParams: log.requestParams,
      errorMessage: log.errorMessage,
    }));

    return {
      list,
      totalCount,
      totalPage: Math.ceil(totalCount / take),
      currentPage: page,
    };
  }

  /**
   * 액션 타입 목록 조회 (드롭박스용)
   */
  async getActionTypes(): Promise<GetActionTypesResDto> {
    const result = await this.activityLogRepository
      .createQueryBuilder('activityLog')
      .select('DISTINCT activityLog.actionType', 'actionType')
      .where('activityLog.deletedAt IS NULL')
      .orderBy('activityLog.actionType', 'ASC')
      .getRawMany();

    const actionTypes = result.map((r) => r.actionType);

    return { actionTypes };
  }

  /**
   * 활동 로그 엑셀 다운로드
   */
  async downloadActivityLogExcel(dto: DownloadActivityLogExcelReqDto, res: Response): Promise<void> {
    const { startAt, endAt, actionType, searchKeyword } = dto;

    const queryBuilder = this.activityLogRepository
      .createQueryBuilder('activityLog')
      .leftJoin('activityLog.user', 'user')
      .leftJoin('user.company', 'company')
      .addSelect(['user.personName', 'company.businessName'])
      .where('activityLog.deletedAt IS NULL');

    // 기간 검색
    if (startAt) {
      queryBuilder.andWhere('activityLog.createdAt >= :startAt', { startAt: `${startAt} 00:00:00` });
    }
    if (endAt) {
      queryBuilder.andWhere('activityLog.createdAt <= :endAt', { endAt: `${endAt} 23:59:59` });
    }

    // 액션 타입 검색
    if (actionType) {
      queryBuilder.andWhere('activityLog.actionType = :actionType', { actionType });
    }

    // 검색어 (IP 주소 또는 이메일)
    if (searchKeyword) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('activityLog.ipAddress LIKE :searchKeyword', { searchKeyword: `%${searchKeyword}%` }).orWhere(
            'activityLog.userEmail LIKE :searchKeyword',
            { searchKeyword: `%${searchKeyword}%` },
          );
        }),
      );
    }

    queryBuilder.orderBy('activityLog.createdAt', 'DESC');

    const logs = await queryBuilder.getMany();

    // 엑셀 워크북 생성
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('활동 로그');

    // 헤더 설정
    worksheet.columns = [
      { header: '생성일시', key: 'createdAt', width: 20 },
      { header: '고객사명', key: 'companyName', width: 25 },
      { header: '담당자 이름', key: 'personName', width: 15 },
      { header: '사용자 이메일', key: 'userEmail', width: 30 },
      { header: '요청 URL', key: 'requestUrl', width: 50 },
      { header: '액션 타입', key: 'actionType', width: 20 },
      { header: 'IP 주소', key: 'ipAddress', width: 20 },
      { header: '다운로드 사유', key: 'downloadReason', width: 40 },
      { header: '레코드 수', key: 'recordCount', width: 12 },
      { header: '요청 파라미터', key: 'requestParams', width: 40 },
      { header: '에러 메시지', key: 'errorMessage', width: 40 },
    ];

    // 헤더 스타일 설정
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };

    // 데이터 추가
    logs.forEach((log) => {
      worksheet.addRow({
        createdAt: format(log.createdAt, DateFormatStr),
        companyName: log.user?.company?.businessName || '',
        personName: log.user?.personName || '',
        userEmail: log.userEmail,
        requestUrl: log.requestUrl,
        actionType: log.actionType,
        ipAddress: log.ipAddress,
        downloadReason: log.downloadReason || '',
        recordCount: log.recordCount || '',
        requestParams: log.requestParams ? JSON.stringify(log.requestParams) : '',
        errorMessage: log.errorMessage || '',
      });
    });

    // 파일명 생성
    const fileName = `activity_log_${format(new Date(), 'yyyyMMdd_HHmmss')}.xlsx`;

    // 응답 헤더 설정
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);

    // 엑셀 파일 전송
    await workbook.xlsx.write(res);
    res.end();
  }

  /**
   * 특정 유저의 잔액 충전/수정 이력 조회
   * @param targetUserId 대상 유저 ID
   * @returns 잔액 관련 활동 로그 목록
   */
  async getBalanceHistoryByUserId(targetUserId: number): Promise<ActivityLogEntity[]> {
    return this.activityLogRepository
      .createQueryBuilder('activityLog')
      .where('activityLog.deletedAt IS NULL')
      .andWhere('activityLog.actionType IN (:...actionTypes)', {
        actionTypes: ['BALANCE_CHARGE', 'BALANCE_MODIFY', 'BALANCE_REFUND', 'DISCARD_RESTORE'],
      })
      .andWhere(
        // 여신복구(ALL_SETTLE_AMOUNT)는 예치금/선입금 이동이 아니라 예치금 이력에서 제외(저장부 user_task_history 제외 규칙과 정합).
        // restoreType 없는 과거 로그는 하위호환으로 노출.
        "(activityLog.actionType <> 'DISCARD_RESTORE' OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(activityLog.requestParams, '$.restoreType')), '') <> 'ALL_SETTLE_AMOUNT')",
      )
      .andWhere("JSON_EXTRACT(activityLog.requestParams, '$.targetUserId') = :targetUserId", {
        targetUserId,
      })
      .orderBy('activityLog.createdAt', 'DESC')
      .getMany();
  }

  /**
   * 특정 유저(회사)의 최대서비스한도 변경 이력 조회
   * @param targetUserId 대상 유저 ID
   * @returns 최대서비스한도 변경 활동 로그 목록
   */
  async getMaximumLimitHistoryByUserId(targetUserId: number): Promise<ActivityLogEntity[]> {
    return this.activityLogRepository
      .createQueryBuilder('activityLog')
      .where('activityLog.deletedAt IS NULL')
      .andWhere('activityLog.actionType = :actionType', {
        actionType: 'MAXIMUM_LIMIT_MODIFY',
      })
      .andWhere("JSON_EXTRACT(activityLog.requestParams, '$.targetUserId') = :targetUserId", {
        targetUserId,
      })
      .orderBy('activityLog.createdAt', 'DESC')
      .getMany();
  }

  /**
   * 리포트 기본 타입으로 조회할 때 함께 반환할 actionType 목록.
   *
   * 이메일 전송도 발행으로 집계하므로(order.*ReportCount 증가), 정산 목록의 "발행" 버튼이
   * 이메일로만 발행한 건에도 뜬다. 그때 기본 타입만 조회하면 이력이 비어 있는 모달이 열린다
   * — 발행됐다고 표시해 놓고 근거를 못 보여주는 상태. 기본 타입 조회에 *_EMAIL 을 합쳐 해소한다.
   *
   * *_EMAIL 을 직접 지정한 조회(인쇄 화면들)는 그대로 이메일 이력만 받는다.
   *
   * ⚠️ 반드시 Map 이어야 한다. 객체 리터럴로 두면 미검증 쿼리스트링이 프로토타입 체인을 탄다 —
   * ?reportType=constructor 는 `obj['constructor']` 가 Object 생성자(truthy)를 돌려줘 `??` 폴백이
   * 발동하지 않고, 그 함수가 IN (:...actionTypes) 로 흘러가 드라이버에서 TypeError → 500 이 된다
   * (toString / __proto__ / valueOf 도 동일). Map 은 자체 키만 보므로 이 경로가 닫힌다.
   */
  private static readonly REPORT_HISTORY_ACTION_TYPES = new Map<string, string[]>([
    ['DELIVERY_COMPLETE_REPORT', ['DELIVERY_COMPLETE_REPORT', 'DELIVERY_COMPLETE_REPORT_EMAIL']],
    ['TRANSACTION_STATEMENT', ['TRANSACTION_STATEMENT', 'TRANSACTION_STATEMENT_EMAIL']],
  ]);

  /**
   * 주문별 발행 이력 조회 (발송완료리포트/거래명세서/이메일발송)
   * @param orderId 주문 ID
   * @param reportType 리포트 타입. 기본 타입이면 대응 *_EMAIL 이력도 함께 반환한다.
   */
  async getOrderReportHistory(
    orderId: number,
    reportType: IReportHistoryType,
  ): Promise<{ userEmail: string; createdAt: string; source: string | null; to: string | null; cc: string | null }[]> {
    const actionTypes = ActivityLogService.REPORT_HISTORY_ACTION_TYPES.get(reportType) ?? [reportType];

    const logs = await this.activityLogRepository
      .createQueryBuilder('activityLog')
      .where('activityLog.deletedAt IS NULL')
      .andWhere('activityLog.actionType IN (:...actionTypes)', { actionTypes })
      // 성공 건만 "발행 이력"이다. sendReportEmail 은 발송 실패 시에도 같은 actionType 으로
      // 로그를 남기는데(statusCode 500 / result FAILURE), 응답 DTO 에는 result 필드가 없어
      // 화면에서 성공 행과 구별할 방법이 없다. 걸러내지 않으면 운영자가 실패한 발송을
      // "이미 보냈다"로 읽고 재발송하지 않아 고객사가 리포트를 영영 못 받는다.
      .andWhere('activityLog.result = :succeeded', { succeeded: ActivityLogResult.SUCCESS })
      .andWhere("JSON_EXTRACT(activityLog.requestParams, '$.orderId') = :orderId", { orderId })
      .orderBy('activityLog.createdAt', 'DESC')
      .getMany();

    return logs.map((log) => ({
      userEmail: log.userEmail,
      createdAt: format(log.createdAt, DateFormatStr),
      // 이메일 경로는 requestParams 에 source 가 없다(to/cc 만 있다). 그 행이 어느 경로였는지
      // 프론트가 구분할 수 있도록 EMAIL 로 채워 준다. PDF 경로는 저장된 source 를 그대로 쓴다.
      source: log.requestParams?.source || (log.actionType.endsWith('_EMAIL') ? IReportSource.EMAIL : null),
      to: log.requestParams?.to || null,
      cc: log.requestParams?.cc || null,
    }));
  }
}
