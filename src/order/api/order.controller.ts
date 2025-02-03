import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { OrderService } from '../application/order.service';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  OrderCreateTempReqDto,
  OrderDeliveryCancelReqDto,
  OrderDeliveryConfirmedReqDto,
  OrderDeliveryRequestReqDto,
  OrderGetDetailReqParamDto,
  OrderGetListReqDto,
  OrderUpdateOperationUserReqDto,
  OrderUpdateTempReqDto,
} from './order.req.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { OrderCreateTempResDto, OrderGetDetailResDto, OrderGetListResDto } from './order.res.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { User } from '../../auth/api/user.decorator';
import { AuthUserSuperAdminGuard } from '../../auth/api/auth.user.super-admin.guard';

@ApiTags('order')
@ApiBearerAuth()
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class OrderController {
  constructor(private orderService: OrderService) {}

  @ApiOperation({
    summary: '주문 및 발송 관리 list 조회 API',
    description:
      '주문관리시 유저가 등록한 주문만 출력됩니다.<br>' +
      '발송 관리 일시 기업 관리자 -> 등록한 주문<br>' +
      '운영 관리자 -> 최고 관리자가 지정 한 주문 <br>' +
      '최고 관리자 -> 전체 주문 ',
  })
  @ApiOkResponse({
    type: OrderGetListResDto,
    description: '성공적으로 조회한 경우',
  })
  // ====================================================
  @Get('/order/list')
  getList(@User() user: ILoginUserInfo, @Query() getQuery: OrderGetListReqDto) {
    return this.orderService.getList(user, getQuery);
  }

  @ApiOperation({
    summary: '주문 detail 조회 API',
  })
  @ApiOkResponse({
    type: OrderGetDetailResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 order id 가 존재하지 않는 경우',
  })
  // ====================================================
  @Get('/order/detail/:id')
  getDetail(@Param() getParam: OrderGetDetailReqParamDto) {
    return this.orderService.getDetail(getParam);
  }

  @ApiOperation({
    summary: '주문 관리 임시 저장 API',
    description: '주문 임시 저장이며 request body 를 참고하여 default 임시 저장시 값을 동일하게 보내주셔야 합니다.',
  })
  @ApiCreatedResponse({
    type: OrderCreateTempResDto,
    description: '성공적으로 생성한 경우',
  })
  // ====================================================
  @Post('/order/temp')
  createTemp(@User() user: ILoginUserInfo, @Body() getBody: OrderCreateTempReqDto) {
    return this.orderService.createTemp(user, getBody);
  }

  @ApiOperation({
    summary: '주문 관리 임시 저장 업데이트 API',
    description: 'orderProduct 및 orderDelivery 데이터는 기존의 데이터를 삭제 후 재생성합니다.',
  })
  @ApiCreatedResponse({
    description: '성공적으로 생성한 경우',
  })
  // ====================================================
  @Put('/order/temp')
  updateTemp(@User() user: ILoginUserInfo, @Body() getBody: OrderUpdateTempReqDto) {
    return this.orderService.updateTemp(user, getBody);
  }

  @ApiOperation({
    summary: '주문 완료(발송 요청) API',
    description: '임시 저장된 주문 중에 주문 완료으로 변환합니다. ',
  })
  @ApiCreatedResponse({
    description: '성공적으로 주문 완료으로 변환한 경우',
  })
  @ApiBadRequestResponse({
    description:
      '이벤트 명이 존재하지 않을 경우 <br>' +
      '발송 요청시각이 default 로 설정되어 있는 경우 <br>' +
      '발신번호가 존재하지 않는 경우 <br>' +
      '제목이 존재하지 않는 경우 <br>' +
      '내용이 존재하지 않는 경우',
  })
  // ====================================================
  @Post('/order/delivery-request')
  deliveryRequest(@User() user: ILoginUserInfo, @Body() getBody: OrderDeliveryRequestReqDto) {
    return this.orderService.deliveryRequest(user, getBody);
  }

  @ApiOperation({
    summary: '발송 확정(발송 대기) API',
    description: '주문 확정 된 주문 중 발송 확정(발송 대기) 변환합니다. ',
  })
  @ApiCreatedResponse({
    description: '성공적으로 주문 확정으로 변환한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 주문이 존재하지 않는 경우',
  })
  // ====================================================
  @Post('/order/delivery-confirmed')
  deliveryConfirmed(@User() user: ILoginUserInfo, @Body() getBody: OrderDeliveryConfirmedReqDto) {
    return this.orderService.deliveryConfirmed(user, getBody);
  }

  @ApiOperation({
    summary: '발송 취소 API',
    description: '발송 관리에서 해당 주문 주문을 취소합니다.',
  })
  @ApiCreatedResponse({
    description: '성공적으로 주문 확정으로 변환한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 주문이 존재하지 않을 경우',
  })
  // ====================================================
  @Post('/order/delivery-cancel')
  deliveryCancel(@User() user: ILoginUserInfo, @Body() getBody: OrderDeliveryCancelReqDto) {
    return this.orderService.deliveryCancel(user, getBody);
  }

  @ApiOperation({
    summary: '최고 관리자의 운영 담당자 지정 API',
  })
  @ApiBadRequestResponse({
    description:
      '해당주문이 존재하지 않을 경우 <br>' + '해당 유저가 존재하지 않을 경우 <br>' + '운영담당자 유저가 아닌 경우',
  })
  // ====================================================
  @UseGuards(AuthUserSuperAdminGuard)
  @Patch('/order/operation-user')
  updateOperationUser(@Body() getBody: OrderUpdateOperationUserReqDto) {
    return this.orderService.updateOperationUser(getBody);
  }
}
