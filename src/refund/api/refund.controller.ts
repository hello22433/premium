import { Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RefundService } from '../application/refund.service';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RefundGetListResDto } from './refund.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { RefundGetListReqQueryDto, RefundResetReqDto, RefundUpdateReqDto } from './refund.req.dto';
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
  update(@Body() getDto: RefundUpdateReqDto) {
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
  reset(@Body() getDto: RefundResetReqDto) {
    return this.refundService.reset(getDto);
  }
}
