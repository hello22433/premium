import { CustomerServiceService } from '../application/customer.service.service';
import { Body, Controller, Get, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import {
  CustomerServiceCouponRefreshReqDto,
  CustomerServiceDiscardReqDto,
  CustomerServiceGetDetailListReqDto,
  CustomerServiceGetDetailReqDto,
  CustomerServiceGetListReqDto,
  CustomerServiceHistoryReqDto,
  CustomerServicePinStatusModifyReqDto,
  CustomerServicePinStatusRefreshReqDto,
  CustomerServiceReSendReqDto,
  CustomerServiceStatusListReqDto,
  CustomerServiceUnmaskedDeliveryTargetReqDto,
} from './customer.service.req.dto';
import {
  CustomerServiceGetDetailListResDto,
  CustomerServiceGetListResDto,
  CustomerServiceGetDetailResDto,
  CustomerServiceUnmaskedDeliveryTargetResDto
} from './customer.service.res.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { User } from '../../auth/api/user.decorator';

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
    description: '일반쿠폰, 신세계 주문 클릭시 detail CS list 조회 API',
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
    description: '일반쿠폰, 신세계 주문 클릭시 CS detail 조회 API',
  })
  @ApiOkResponse({
    type: CustomerServiceGetDetailResDto,
    description: '성공적으로 return 한 경우',
  })
  // ===============================================
  @Get('/customer-service/detail')
  getDetail(@Query() getQuery: CustomerServiceGetDetailReqDto) {
    return this.customerServiceService.getDetail(getQuery);
  }

  @ApiOperation({
    description: '핀상태변경 API',
  })
  @ApiOkResponse({
    description: '성공적으로 return 한 경우',
  })
  @Put('/customer-service/pin-status/modify')
  async pinStatusModify(@User() user: ILoginUserInfo, @Body() getBody: CustomerServicePinStatusModifyReqDto) {
    // 1. 유효성검사
    await this.customerServiceService.validPinStatusModify(getBody);

    // 2. 데이터매핑
    const map = await this.customerServiceService.mapPinStatusModify(user, getBody);
    
    // 3. 서비스실행
    return await this.customerServiceService.execPinStatusModify(map);
  }

  @ApiOperation({
    description: '핀상태갱신 API',
  })
  @ApiOkResponse({
    description: '성공적으로 return 한 경우',
  })
  @Put('/customer-service/pin-status/refresh')
  async pinStatusRefresh(@User() user: ILoginUserInfo, @Body() getBody: CustomerServicePinStatusRefreshReqDto) {
    // 1. 유효성검사
    await this.customerServiceService.validPinStatusRefresh(getBody);

    // 2. 데이터매핑
    const map = await this.customerServiceService.mapPinStatusRefresh(user, getBody);
    
    // 3. 서비스실행
    return await this.customerServiceService.execPinStatusRefresh(map);
  }

  @ApiOperation({
    description: 'CS 등록 API',
  })
  @ApiOkResponse({
    description: '성공적으로 return 한 경우',
  })
  @Post('/customer-service/history')
  async history(@User() user: ILoginUserInfo, @Body() getBody: CustomerServiceHistoryReqDto) {
    // 1. 유효성검사
    await this.customerServiceService.validHistory(getBody);

    // 2. 데이터매핑
    const map = await this.customerServiceService.mapHistory(user, getBody);
    
    // 3. 서비스실행
    return await this.customerServiceService.execHistory(map);
  }

  @ApiOperation({
    description: '변경내역 상세 list 조회 API',
  })
  @ApiOkResponse({
    description: '성공적으로 return 한 경우',
  })
  @Get('/customer-service/status/list')
  async statusList(@Query() getQuery: CustomerServiceStatusListReqDto) {
    // 1. 유효성검사
    await this.customerServiceService.validStatusList(getQuery);

    // 2. 데이터매핑
    const map = await this.customerServiceService.mapStatusList(getQuery);
    
    // 3. 서비스실행
    return await this.customerServiceService.execStatusList(map);
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
    description: '마스킹되지 않은 수신정보 조회 API',
  })
  @ApiOkResponse({
    type: CustomerServiceUnmaskedDeliveryTargetResDto,
    description: '성공적으로 return 한 경우',
  })
  // ===============================================
  @Get('/customer-service/unmasked-delivery-target')
  getUnmaskedDeliveryTarget(@Query() getQuery: CustomerServiceUnmaskedDeliveryTargetReqDto) {
    return this.customerServiceService.getUnmaskedDeliveryTarget(getQuery);
  }

}
