import { Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RefundService } from '../application/refund.service';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RefundGetListResDto } from './refund.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import {
  RefundGetListReqQueryDto,
  RefundResetBatchReqDto,
  RefundResetReqDto,
  RefundUpdateBatchReqDto,
  RefundUpdateReqDto,
} from './refund.req.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { User } from '../../auth/api/user.decorator';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { AuthService } from '../../auth/application/auth.service';

@Controller('')
@ApiTags('refund')
@UseGuards(AuthUserAuthorizationGuard)
@ApiBearerAuth()
export class RefundController {
  constructor(
    private refundService: RefundService,
    private authService: AuthService,
  ) {}

  @ApiOperation({
    summary: '고객관리 > 환불관리 list API',
  })
  @ApiOkResponse({
    type: RefundGetListResDto,
  })
  // =================================
  @Get('/settle/refund/list')
  async getList(@User() user: ILoginUserInfo, @Query() getDto: RefundGetListReqQueryDto, @Req() req: Request) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.CUSTOMER_REFUND);

    return this.refundService.getList(getDto, {
      user,
      ipAddress: req.ip || '',
      userAgent: req.headers['user-agent'],
    });
  }

  @ApiOperation({
    summary: '고객관리 > 환불관리 업데이트 API',
  })
  @ApiOkResponse({
    type: '',
  })
  @ApiBadRequestResponse({
    description: '주문이 존재하지 않을 경우, 환불 완료 시 일자를 입력하지 않은 경우',
  })
  // =================================
  @Put('/settle/refund')
  async update(@User() user: ILoginUserInfo, @Body() getDto: RefundUpdateReqDto) {
    // 권한검사: 환불 관리 권한 (getList 와 동일 — 쓰기도 동일 권한 요구)
    await this.authService.authorityValidator(user, UserAuthSubEnum.CUSTOMER_REFUND);
    return this.refundService.update(getDto);
  }

  @ApiOperation({
    summary: '고객관리 > 환불관리 진행중 행 입력값 초기화 API',
  })
  @ApiOkResponse({
    type: '',
  })
  @ApiBadRequestResponse({
    description: '주문이 존재하지 않거나, 진행중 상태가 아닌 경우',
  })
  // =================================
  @Put('/settle/refund/reset')
  async reset(@User() user: ILoginUserInfo, @Body() getDto: RefundResetReqDto) {
    // 권한검사: 환불 관리 권한 (getList 와 동일 — 쓰기도 동일 권한 요구)
    await this.authService.authorityValidator(user, UserAuthSubEnum.CUSTOMER_REFUND);
    return this.refundService.reset(getDto);
  }

  @ApiOperation({
    summary: '고객관리 > 환불관리 진행중 행 입력값 일괄 초기화 API',
  })
  @ApiOkResponse({
    type: '',
  })
  @ApiBadRequestResponse({
    description: '대상 중 하나라도 존재하지 않거나 진행중 상태가 아니면 전체 실패(롤백)',
  })
  // =================================
  @Put('/settle/refund/batch-reset')
  async batchReset(@User() user: ILoginUserInfo, @Body() getDto: RefundResetBatchReqDto) {
    // 권한검사: 환불 관리 권한 (getList 와 동일 — 쓰기도 동일 권한 요구)
    await this.authService.authorityValidator(user, UserAuthSubEnum.CUSTOMER_REFUND);
    return this.refundService.resetBatch(getDto);
  }

  @ApiOperation({
    summary: '고객관리 > 환불관리 일괄 업데이트(저장) API',
  })
  @ApiOkResponse({
    type: '',
  })
  @ApiBadRequestResponse({
    description: '대상 중 하나라도 존재하지 않거나 검증 실패 시 전체 실패(롤백)',
  })
  // =================================
  @Put('/settle/refund/batch-update')
  async batchUpdate(@User() user: ILoginUserInfo, @Body() getDto: RefundUpdateBatchReqDto) {
    // 권한검사: 환불 관리 권한 (getList 와 동일 — 쓰기도 동일 권한 요구)
    await this.authService.authorityValidator(user, UserAuthSubEnum.CUSTOMER_REFUND);
    return this.refundService.updateBatch(getDto);
  }
}
