import { BadRequestException, Body, Controller, Get, Ip, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { CreditExcessApprovalStatus } from '../../entity/credit.excess.approval.entity';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { CreditExcessApprovalDispatchService } from '../application/credit-excess-approval-dispatch.service';

/**
 * 신용초과 승인 API.
 *
 * 흐름: 발송확정(`credit_excess` 응답) → 승인 요청 → 운영자 승인 → **서버가 발송확정 실행**.
 * 승인 이후 사용자의 발송확정 재시도는 없다.
 */
export class CreditExcessApprovalRequestReqDto {
  @ApiProperty({ description: '주문 ID' })
  @IsInt()
  @Min(1)
  orderId: number;

  @ApiProperty({ description: '요청 사유 (1~200자)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reasonText: string;

  @ApiPropertyOptional({ description: '포인트 사용 요청액 (발송확정과 동일 규칙). WALLET 모드 전용' })
  @IsOptional()
  @IsInt()
  @Min(0)
  pointUseAmount?: number;

  @ApiPropertyOptional({ description: '후정산 예치금 사용 토글. WALLET 모드 전용' })
  @IsOptional()
  @IsBoolean()
  depositUseEnabled?: boolean;

  @ApiPropertyOptional({ description: '후정산 예치금 사용 요청액. WALLET 모드 전용' })
  @IsOptional()
  @IsInt()
  @Min(0)
  depositUseAmount?: number;
}

export class CreditExcessApprovalRejectReqDto {
  @ApiProperty({ description: '거절 사유' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  rejectReason: string;
}

export class CreditExcessApprovalListReqDto extends PagingReqDto {
  @ApiPropertyOptional({ enum: CreditExcessApprovalStatus, description: '상태 필터 (미지정 시 전체)' })
  @IsOptional()
  @IsEnum(CreditExcessApprovalStatus)
  status?: CreditExcessApprovalStatus;
}

export class CreditExcessApprovalListItemResDto {
  @ApiProperty({ description: '승인 ID' })
  id: string;

  @ApiProperty({ description: '주문 ID' })
  orderId: number;

  @ApiProperty({ description: '요청자 이름' })
  requesterName: string;

  @ApiProperty({ description: '요청자 회사명' })
  requesterCompanyName: string;

  @ApiProperty({ description: '요청 시각 (ISO, UTC)' })
  requestedAt: string;

  @ApiProperty({ description: '서버 계산 청구 금액' })
  requestedAmount: number;

  @ApiProperty({ description: '서버 계산 신용초과 금액' })
  requestedCreditExcessAmount: number;

  @ApiProperty({ description: '요청 사유' })
  reasonText: string;

  @ApiProperty({ enum: CreditExcessApprovalStatus, description: '상태' })
  status: CreditExcessApprovalStatus;

  @ApiPropertyOptional({ description: '승인/거절자 이름', nullable: true })
  approverName?: string | null;

  @ApiPropertyOptional({ description: '거절 사유', nullable: true })
  rejectReason?: string | null;

  @ApiPropertyOptional({ description: '요청자 노출 메시지', nullable: true })
  userMessage?: string | null;

  @ApiPropertyOptional({ description: '변경된 항목명 (재요청 필요 시)', nullable: true, type: [String] })
  changedFields?: string[] | null;

  @ApiPropertyOptional({ description: '운영 진단 코드 (운영자 전용)', nullable: true })
  diagnosticCode?: string | null;

  @ApiPropertyOptional({ description: '내부 원인 (운영자 전용)', nullable: true })
  internalReason?: string | null;

  @ApiPropertyOptional({ description: '실행 시작 시각 (운영자 전용)', nullable: true })
  processingStartedAt?: string | null;

  @ApiPropertyOptional({ description: '종료 시각 (운영자 전용)', nullable: true })
  finishedAt?: string | null;

  @ApiPropertyOptional({ description: '실행 시도 횟수 (운영자 전용)' })
  attemptCount?: number;
}

export class CreditExcessApprovalListResDto extends GetListResDto {
  @ApiProperty({ type: [CreditExcessApprovalListItemResDto], description: '승인 목록' })
  list: CreditExcessApprovalListItemResDto[];
}

export class CreditExcessApprovalExecutionResDto {
  @ApiProperty({ description: '승인 ID' })
  approvalId: string;

  @ApiProperty({ description: '주문 ID' })
  orderId: number;

  @ApiProperty({ enum: CreditExcessApprovalStatus, description: '실행 결과 상태' })
  status: CreditExcessApprovalStatus;

  @ApiProperty({ description: '사용자 노출 메시지' })
  userMessage: string;

  @ApiPropertyOptional({ description: '변경된 항목명', nullable: true, type: [String] })
  changedFields?: string[] | null;

  @ApiPropertyOptional({ description: '운영 진단 코드', nullable: true })
  diagnosticCode?: string | null;
}

@ApiBearerAuth()
@ApiTags('credit-excess-approvals')
@Controller('credit-excess-approvals')
@UseGuards(AuthUserAuthorizationGuard)
export class CreditExcessApprovalController {
  constructor(private readonly service: CreditExcessApprovalDispatchService) {}

  @Post()
  @ApiOperation({
    summary: '신용초과 승인 요청 생성',
    description:
      '발송확정이 credit_excess 응답을 반환한 주문에 대해 승인을 요청한다. ' +
      '금액/정산계정은 서버가 주문 잠금 안에서 직접 계산하며 클라이언트 값은 받지 않는다.',
  })
  @ApiOkResponse({ type: CreditExcessApprovalListItemResDto })
  request(
    @User() user: ILoginUserInfo,
    @Body() body: CreditExcessApprovalRequestReqDto,
  ): Promise<CreditExcessApprovalListItemResDto> {
    return this.service.request(user, body);
  }

  @Get('my')
  @ApiOperation({ summary: '내 신용초과 승인 요청 목록 (요청자)' })
  @ApiOkResponse({ type: CreditExcessApprovalListResDto })
  listMine(
    @User() user: ILoginUserInfo,
    @Query() query: CreditExcessApprovalListReqDto,
  ): Promise<CreditExcessApprovalListResDto> {
    return this.service.listForRequester(user, query);
  }

  @Get('my/:id')
  @ApiOperation({ summary: '내 신용초과 승인 요청 상세 (요청자)' })
  @ApiOkResponse({ type: CreditExcessApprovalListItemResDto })
  findMine(@User() user: ILoginUserInfo, @Param('id') id: string): Promise<CreditExcessApprovalListItemResDto> {
    return this.service.findForRequester(user, this.validateApprovalId(id));
  }

  @Get()
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiOperation({ summary: '신용초과 승인 목록 조회 (운영자, 진단 정보 포함)' })
  @ApiOkResponse({ type: CreditExcessApprovalListResDto })
  list(@Query() query: CreditExcessApprovalListReqDto): Promise<CreditExcessApprovalListResDto> {
    return this.service.listForOperator(query);
  }

  @Get(':id')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiOperation({ summary: '신용초과 승인 상세 조회 (운영자, 진단 정보 포함)' })
  @ApiOkResponse({ type: CreditExcessApprovalListItemResDto })
  findOne(@Param('id') id: string): Promise<CreditExcessApprovalListItemResDto> {
    return this.service.findForOperator(this.validateApprovalId(id));
  }

  @Post(':id/approve')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiOperation({
    summary: '신용초과 승인 = 서버 발송확정 실행',
    description:
      '승인 1회로 주문 발송확정(DELIVERY_CONFIRMED)과 배치 대기(WAIT) 등록까지 서버가 수행한다. ' +
      '같은 승인 ID 재호출은 현재 상태를 멱등 반환한다.',
  })
  @ApiOkResponse({ type: CreditExcessApprovalExecutionResDto })
  approve(
    @User() user: ILoginUserInfo,
    @Param('id') id: string,
    @Ip() ip: string,
  ): Promise<CreditExcessApprovalExecutionResDto> {
    return this.service.approve(user, this.validateApprovalId(id), ip ?? '');
  }

  @Post(':id/reject')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiOperation({ summary: '신용초과 승인 거절' })
  @ApiOkResponse({ type: CreditExcessApprovalListItemResDto })
  reject(
    @User() user: ILoginUserInfo,
    @Param('id') id: string,
    @Body() body: CreditExcessApprovalRejectReqDto,
  ): Promise<CreditExcessApprovalListItemResDto> {
    return this.service.reject(user, this.validateApprovalId(id), body.rejectReason);
  }

  private validateApprovalId(id: string): string {
    if (!/^\d+$/.test(id)) {
      throw new BadRequestException(`approval id must be numeric string, got '${id}'`);
    }
    return id;
  }
}
