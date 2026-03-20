import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { ActivityLogEntity } from '../../entity/activity.log.entity';
import { ActivityLogResult } from '../interface/activity.log.result';
import { UserEntity } from '../../entity/user.entity';
import { PasswordBcryptEncrypt } from '../../auth/infrastructure/password.bcrypt.encrypt';
import { GetActivityLogListReqDto, DownloadActivityLogExcelReqDto } from '../api/activity.log.req.dto';
import { GetActivityLogListResDto, GetActionTypesResDto, ActivityLogViewDto } from '../api/activity.log.res.dto';
import { format } from 'date-fns';
import { DateFormatStr } from '../../common/domain/date.format.str';
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
   * 활동 로그 생성
   */
  async createLog(dto: CreateActivityLogDto): Promise<void> {
    await this.activityLogRepository.insert({
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
      requestParams: dto.requestParams || null,
      errorMessage: dto.errorMessage || null,
    });
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

    let queryBuilder = this.activityLogRepository
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
   * 주문별 발행 이력 조회 (발송완료리포트/거래명세서/이메일발송)
   * @param orderId 주문 ID
   * @param reportType 리포트 타입
   */
  async getOrderReportHistory(
    orderId: number,
    reportType: 'DELIVERY_COMPLETE_REPORT' | 'TRANSACTION_STATEMENT' | 'DELIVERY_COMPLETE_REPORT_EMAIL' | 'TRANSACTION_STATEMENT_EMAIL' | 'DESTRUCTION_CERTIFICATE_EMAIL',
  ): Promise<{ userEmail: string; createdAt: string; source: string | null; to: string | null; cc: string | null }[]> {
    const logs = await this.activityLogRepository
      .createQueryBuilder('activityLog')
      .where('activityLog.deletedAt IS NULL')
      .andWhere('activityLog.actionType = :actionType', { actionType: reportType })
      .andWhere("JSON_EXTRACT(activityLog.requestParams, '$.orderId') = :orderId", { orderId })
      .orderBy('activityLog.createdAt', 'DESC')
      .getMany();

    return logs.map((log) => ({
      userEmail: log.userEmail,
      createdAt: format(log.createdAt, DateFormatStr),
      source: log.requestParams?.source || null,
      to: log.requestParams?.to || null,
      cc: log.requestParams?.cc || null,
    }));
  }
}
