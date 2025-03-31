import { Body, Controller, Get, Logger, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { OrderService } from '../application/order.service';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  OrderCreateSettleReqDto,
  OrderCreateTempReqDto,
  OrderDeliveryCancelReqDto,
  OrderDeliveryConfirmedReqDto,
  OrderDeliveryRequestReqDto,
  OrderDeliverySsgCouponExpireChangeReqDto,
  OrderExcelDownloadReqBodyDto,
  OrderGetDeliveryCompleteReportPdfReqDto,
  OrderGetDeliveryCompleteReportReqDto,
  OrderGetDetailReqParamDto,
  OrderGetListReqDto,
  OrderGetOrderCompleteReportPdfReqDto,
  OrderGetOrderCompleteReportReqDto,
  OrderGetSettleReqDto,
  OrderUpdateOperationUserReqDto,
  OrderUpdateSettleReqDto,
  OrderUpdateTempReqDto,
} from './order.req.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import {
  OrderCreateTempResDto,
  OrderDeliveryConfirmed,
  OrderGetDeliveryCompleteReportResDto,
  OrderGetDetailResDto,
  OrderGetListResDto,
  OrderGetMyOrderHistoryResDto,
  OrderGetOrderCompleteReportResDto,
  OrderGetSettleGetListResDto,
} from './order.res.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { User } from '../../auth/api/user.decorator';
import { AuthUserSuperAdminGuard } from '../../auth/api/auth.user.super-admin.guard';
import * as fs from 'fs';
import { Response } from 'express';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';

@ApiTags('order')
@ApiBearerAuth()
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class OrderController {
  constructor(private orderService: OrderService) {}

  private logger = new Logger('ORDER');

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
    summary: '일반 상품 발송 완료 리포트 PDF 주문 상세 조회 API',
  })
  @ApiOkResponse({
    type: OrderGetDeliveryCompleteReportResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 order id 가 존재하지 않는 경우',
  })
  // ====================================================
  @Get('/order/delivery-complete/report')
  getDeliveryCompleteReport(@Query() getQuery: OrderGetDeliveryCompleteReportReqDto) {
    return this.orderService.getDeliveryCompleteReport(getQuery);
  }

  @ApiOperation({
    summary: '일반 상품 발송 완료 리포트 PDF 다운로드 카운트 API',
  })
  @ApiOkResponse({
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 order id 가 존재하지 않는 경우',
  })
  // ====================================================
  @Post('/order/delivery-complete/report/pdf')
  deliveryCompleteReportPdf(@Body() getBody: OrderGetDeliveryCompleteReportPdfReqDto) {
    return this.orderService.deliveryCompleteReportPdf(getBody);
  }

  @ApiOperation({
    summary: '일반 상품 거래 명세서 PDF 상세 조회 API',
  })
  @ApiOkResponse({
    type: OrderGetOrderCompleteReportResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 order id 가 존재하지 않는 경우',
  })
  // ====================================================
  @Get('/order/order-complete/report')
  getOrderCompleteReport(@Query() getQuery: OrderGetOrderCompleteReportReqDto) {
    return this.orderService.getOrderCompleteReport(getQuery);
  }

  @ApiOperation({
    summary: '거래 명세서 PDF 다운로드 카운트 API',
  })
  @ApiOkResponse({
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 order id 가 존재하지 않는 경우',
  })
  // ====================================================
  @Post('/order/order-complete/report/pdf')
  orderCompleteReportPdf(@Body() getBody: OrderGetOrderCompleteReportPdfReqDto) {
    return this.orderService.orderCompleteReportPdf(getBody);
  }

  @ApiOperation({
    summary: '정산 정보 조회 API',
  })
  @ApiOkResponse({
    type: OrderGetSettleGetListResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 order id 가 존재하지 않는 경우',
  })
  // ====================================================
  @Get('/order/settle')
  getOrderSettle(@Query() getQuery: OrderGetSettleReqDto) {
    return this.orderService.getOrderSettle(getQuery);
  }

  @ApiOperation({
    summary: '정산 정보 입력 API',
  })
  @ApiOkResponse({
    description: '성공적으로 입력한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 order id 가 존재하지 않는 경우',
  })
  // ====================================================
  @Post('/order/settle')
  createOrderSettle(@Body() getBody: OrderCreateSettleReqDto) {
    return this.orderService.createOrderSettle(getBody);
  }

  @ApiOperation({
    summary: '대시보드 - 나의 주문 내역 조회 API',
  })
  @ApiOkResponse({
    type: OrderGetMyOrderHistoryResDto,
    description: '성공적으로 조회한 경우',
  })
  // ====================================================
  @Get('/order/my/dashboard')
  getMyOrderHistory(@User() user: ILoginUserInfo) {
    return this.orderService.getMyOrderHistory(user);
  }

  @ApiOperation({
    summary: '정산 정보 수정 API',
  })
  @ApiOkResponse({
    description: '성공적으로 수정한 경우',
  })
  @ApiBadRequestResponse({
    description: 'order product mapping id 가 존재하지 않는 경우',
  })
  // ====================================================
  @Put('/order/settle')
  updateOrderSettle(@Body() getBody: OrderUpdateSettleReqDto) {
    return this.orderService.updateOrderSettle(getBody);
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
    type: OrderDeliveryConfirmed,
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
    summary: '신세계 발송 유효기간 변경 API',
    description: '발송 확정 전, 신세계 상품권의 유효기간을 변경하고자 하는 API 입니다.',
  })
  @ApiCreatedResponse({
    description: '성공적으로 변환한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 주문이 존재하지 않는 경우 <br>' + '신세계 이벤트가 존재하지 않을 경우',
  })
  @ApiInternalServerErrorResponse({
    description: '신세계 상품 데이터가 존재하지 않을 경우',
  })
  // ====================================================
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Post('/order/ssg/coupon-expire-change')
  ssgCouponExpireChange(@User() user: ILoginUserInfo, @Body() getBody: OrderDeliverySsgCouponExpireChangeReqDto) {
    return this.orderService.ssgCouponExpireChange(user, getBody);
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

  @ApiOperation({
    summary: '주문 및 발송 관리 list 엑셀 다운로드 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 다운로드한 경우',
  })
  // ===================================================
  @Post('/order/excel-download')
  async excelDownload(
    @User() user: ILoginUserInfo,
    @Body() getBody: OrderExcelDownloadReqBodyDto,
    @Res() res: Response,
  ) {
    try {
      const { fileName, filePath } = await this.orderService.excelDownload(user, getBody);

      const encodedFileName = encodeURIComponent(fileName);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.setHeader('Content-Disposition', `attachment; filename=${encodedFileName}`);

      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);

      fileStream.on('close', async () => {
        fs.unlink(filePath, (unlinkErr) => {
          if (unlinkErr) {
            this.logger.error(`파일 삭제 실패 ${unlinkErr}`);
          }
        });
      });
    } catch (e) {
      throw e;
    }
  }
}
