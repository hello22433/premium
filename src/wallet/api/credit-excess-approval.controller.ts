import {
  Body,
  Controller,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { CreditExcessApprovalService } from '../application/credit-excess-approval.service';

/**
 * 신용초과 4단계 워크플로 API (plan v2.1 Open Decision 2 + PR2 Critic HIGH 2 fix).
 *  - Step B (request): 기업관리자 또는 운영관리자가 사전 승인 row 생성 (PENDING)
 *  - Step C (approve / reject): 운영관리자 권한으로 상태 전이
 *  - Step D (consume): 발송확정 트랜잭션 안에서 호출 (CreditExcessApprovalService.consume)
 */
export class CreditExcessApprovalRequestReqDto {
  @IsInt()
  @Min(1)
  orderId: number;

  /**
   * wallet_account 의 BIGINT PK (string 으로 직렬화 가능).
   * 클라이언트는 deliveryConfirmed 1차 응답의 walletAccountId 를 전달한다.
   */
  @IsString()
  @IsNotEmpty()
  walletAccountId: string;

  @IsInt()
  @Min(1)
  requestedAmount: number;

  @IsInt()
  @Min(1)
  requestedCreditExcessAmount: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reasonText: string;
}

export class CreditExcessApprovalRejectReqDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  rejectReason: string;
}

@ApiBearerAuth()
@ApiTags('credit-excess-approvals')
@Controller('credit-excess-approvals')
@UseGuards(AuthUserAuthorizationGuard)
export class CreditExcessApprovalController {
  constructor(private readonly service: CreditExcessApprovalService) {}

  /**
   * Step B — 기업관리자가 사유 입력 후 사전 승인 요청 (PENDING row 생성).
   * 권한: 모든 인증 사용자 (기업관리자 본인 또는 운영자 대행).
   */
  @Post()
  @ApiOperation({
    summary: '신용초과 사전 승인 요청 (Step B)',
    description:
      'PENDING 상태 row 생성. 발송확정 1차 호출이 credit_excess_pending_approval 응답 반환 시 ' +
      '기업관리자가 reasonText 입력 후 본 endpoint 호출. 운영자 approve 이후 ' +
      'forceConfirm + creditExcessApprovalId 로 발송확정 2차 호출.',
  })
  async request(@User() user: ILoginUserInfo, @Body() body: CreditExcessApprovalRequestReqDto) {
    return this.service.request({ ...body, requestedBy: user.id });
  }

  /**
   * Step C - approve: 운영관리자 권한.
   * Approval ID 는 BIGINT AUTO_INCREMENT (string 으로 직렬화).
   */
  @Post(':id/approve')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiOperation({
    summary: '신용초과 사전 승인 처리 (Step C - approve)',
  })
  async approve(@User() user: ILoginUserInfo, @Param('id', ParseIntPipe) id: number) {
    return this.service.approve(String(id), user.id);
  }

  /**
   * Step C - reject: 운영관리자 권한.
   */
  @Post(':id/reject')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiOperation({
    summary: '신용초과 사전 승인 거절 (Step C - reject)',
  })
  async reject(
    @User() user: ILoginUserInfo,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: CreditExcessApprovalRejectReqDto,
  ) {
    return this.service.reject(String(id), user.id, body.rejectReason);
  }
}
