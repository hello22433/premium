import { CustomerServiceService } from '../application/customer.service.service';
import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import {
  CustomerServiceCouponRefreshReqDto,
  CustomerServiceDiscardReqDto,
  CustomerServiceGetDetailListReqDto,
  CustomerServiceGetListReqDto,
  CustomerServiceReSendReqDto,
} from './customer.service.req.dto';
import { CustomerServiceGetDetailListResDto, CustomerServiceGetListResDto } from './customer.service.res.dto';

@Controller('')
@ApiTags('customer-service')
@ApiBearerAuth()
@UseGuards(AuthUserSuperAndOperationAdminGuard)
export class CustomerServiceController {
  constructor(private customerServiceService: CustomerServiceService) {}

  @ApiOperation({
    description: '일반쿠폰, 신세계 주문 CS API',
  })
  @ApiOkResponse({
    type: CustomerServiceGetListResDto,
    description: '성공적으로 return 한 경우',
  })
  // ===============================================
  @Get('/customer-service/list')
  getList(@Query() getQuery: CustomerServiceGetListReqDto) {
    return this.customerServiceService.getList(getQuery);
  }

  @ApiOperation({
    description: '일반쿠폰, 신세계 주문 클릭시 detail CS API',
  })
  @ApiOkResponse({
    type: CustomerServiceGetDetailListResDto,
    description: '성공적으로 return 한 경우',
  })
  // ===============================================
  @Get('/customer-service/detail/list')
  getDetailList(@Query() getQuery: CustomerServiceGetDetailListReqDto) {
    return this.customerServiceService.getDetailList(getQuery);
  }

  @ApiOperation({
    description: '주문 CS 에서 재발송 API',
  })
  @ApiOkResponse({
    description: '성공적으로 return 한 경우',
  })
  // ===============================================
  @Post('/customer-service/re-send')
  reSend(@Body() getBody: CustomerServiceReSendReqDto) {
    return this.customerServiceService.reSend(getBody);
  }

  @ApiOperation({
    description: '주문 CS 에서 핀폐기 API',
  })
  @ApiOkResponse({
    description: '성공적으로 return 한 경우',
  })
  // ===============================================
  @Post('/customer-service/pin-discard')
  pinDiscard(@Body() getBody: CustomerServiceDiscardReqDto) {
    return this.customerServiceService.pinDiscard(getBody);
  }

  @ApiOperation({ description: '개별 쿠폰 상태 실시간 갱신 API' })
  @ApiOkResponse({ description: '갱신 성공 시 최신 couponStatus 반환' })
  @Get('/customer-service/coupon/refresh')
  refreshCoupon(@Query() getQuery: CustomerServiceCouponRefreshReqDto) {
    return this.customerServiceService.refreshCoupon(getQuery);
  }
}
