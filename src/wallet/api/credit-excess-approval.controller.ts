import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
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

  @Post()
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiOperation({
    summary: '신용초과 사전 승인 요청 (Step B)',
    description: 'PENDING 상태 row 생성. 발송확정 forceConfirm 흐름 직전 호출.',
  })
  async request(@User() user: ILoginUserInfo, @Body() body: CreditExcessApprovalRequestReqDto) {
    return this.service.request({ ...body, requestedBy: user.id });
  }

  @Post(':id/approve')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiOperation({
    summary: '신용초과 사전 승인 처리 (Step C - approve)',
  })
  async approve(@User() user: ILoginUserInfo, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.approve(id, user.id);
  }

  @Post(':id/reject')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @ApiOperation({
    summary: '신용초과 사전 승인 거절 (Step C - reject)',
  })
  async reject(
    @User() user: ILoginUserInfo,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreditExcessApprovalRejectReqDto,
  ) {
    return this.service.reject(id, user.id, body.rejectReason);
  }
}
