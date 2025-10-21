import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { RefundService } from '../application/refund.service';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RefundGetListResDto } from './refund.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { RefundGetListReqQueryDto, RefundUpdateReqDto } from './refund.req.dto';

@Controller('')
@ApiTags('refund')
@UseGuards(AuthUserAuthorizationGuard)
@ApiBearerAuth()
export class RefundController {
  constructor(private refundService: RefundService) {}

  @ApiOperation({
    summary: '고객관리 > 환불관리 list API',
  })
  @ApiOkResponse({
    type: RefundGetListResDto,
  })
  // =================================
  @Get('/settle/refund/list')
  getList(@Query() getDto: RefundGetListReqQueryDto) {
    return this.refundService.getList(getDto);
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
}
