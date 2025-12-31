import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
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
import { DownloadExceptionFilter } from '../../activity_log/api/download.exception.filter';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import {
  OrderCreateSettleReqDto,
  OrderCreateTempReqDto,
  OrderDeleteTempReqDto,
  OrderDeliveryCancelReqDto,
  OrderDeliveryConfirmedReqDto,
  OrderDeliveryRequestReqDto,
  OrderDeliverySsgCouponExpireChangeReqDto,
  OrderExcelDownloadReqBodyDto,
  OrderGetDeliveryCompleteReportPdfReqDto,
  OrderGetDeliveryCompleteReportReqDto,
  OrderGetDestructionCertificatePdfReqDto,
  OrderGetDetailReqParamDto,
  OrderGetListReqDto,
  OrderGetOrderCompleteReportPdfReqDto,
  OrderGetOrderCompleteReportReqDto,
  OrderGetPreviousContentReqQueryDto,
  OrderGetSettleReqDto,
  OrderTestDeliveryReqDto,
  OrderUpdateOperationUserReqDto,
  OrderUpdateSettleReqDto,
  OrderUpdateTempReqDto,
  OrderUpdateEncourageDayReqParamDto,
  OrderUpdateEncourageDayReqBodyDto,
  OrderUpdateTailTextReqParamDto,
  OrderUpdateTailTextReqBodyDto,
  OrderUpdateUseEmailContentReqParamDto,
  OrderUpdateUseEmailContentReqBodyDto,
  OrderGetReportHistoryReqQueryDto,
  OrderGetReportHistoryReqParamDto,
  OrderDeliveryCompleteReportEmailReqDto,
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
  OrderGetPreviousContentResDto,
  OrderGetSettleGetListResDto,
  OrderGetReportHistoryResDto,
} from './order.res.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { User } from '../../auth/api/user.decorator';
import { AuthUserSuperAdminGuard } from '../../auth/api/auth.user.super-admin.guard';
import * as fs from 'fs';
import { Response } from 'express';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

@ApiTags('order')
@ApiBearerAuth()
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class OrderController {
  constructor(
    private orderService: OrderService,
    private activityLogService: ActivityLogService,
    private authService: AuthService,
  ) {}

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
  async getList(@User() user: ILoginUserInfo, @Query() getQuery: OrderGetListReqDto) {
    if (getQuery.section === 'ORDER' && getQuery.type === 'GENERAL') {
      await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_GENERAL);
    }

    if (getQuery.section === 'SHIPPING' && getQuery.type === 'GENERAL') {
      await this.authService.authorityValidator(user, UserAuthSubEnum.SEND_GENERAL);
    }

    if (getQuery.section === 'ORDER' && getQuery.type === 'SSG') {
      await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_SSG);
    }

    if (getQuery.section === 'SHIPPING' && getQuery.type === 'SSG') {
      await this.authService.authorityValidator(user, UserAuthSubEnum.SEND_SSG);
    }

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
    summary: '이벤트 불러오기용 주문 상세 조회 API (수신자 정보 제외)',
  })
  @ApiOkResponse({
    type: OrderGetDetailResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 order id 가 존재하지 않는 경우',
  })
  // ====================================================
  @Get('/order/event-detail/:id')
  getEventDetail(@Param() getParam: OrderGetDetailReqParamDto) {
    return this.orderService.getEventDetail(getParam);
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
  deliveryCompleteReportPdf(
    @Body() getBody: OrderGetDeliveryCompleteReportPdfReqDto,
    @User() user: ILoginUserInfo,
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || '';
    return this.orderService.deliveryCompleteReportPdf(getBody, user, ipAddress);
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
  orderCompleteReportPdf(
    @Body() getBody: OrderGetOrderCompleteReportPdfReqDto,
    @User() user: ILoginUserInfo,
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || '';
    return this.orderService.orderCompleteReportPdf(getBody, user, ipAddress);
  }

  @ApiOperation({
    summary: '파기확인서 PDF 다운로드 로그 기록 API',
  })
  @ApiOkResponse({
    description: '성공적으로 기록한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 order id 가 존재하지 않는 경우',
  })
  // ====================================================
  @Post('/order/destruction-certificate/pdf')
  destructionCertificatePdf(
    @Body() getBody: OrderGetDestructionCertificatePdfReqDto,
    @User() user: ILoginUserInfo,
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || '';
    return this.orderService.destructionCertificatePdf(getBody, user, ipAddress);
  }

  @ApiOperation({
    summary: '다중 주문 발송 완료 리포트 PDF 통합 조회 API',
    description: '여러 주문을 통합하여 발송완료리포트 조회 (동일 고객사만 가능)',
  })
  @ApiOkResponse({
    description: '성공적으로 조회한 경우',
  })
  // ====================================================
  @Get('/order/delivery-complete/report-multiple')
  getDeliveryCompleteReportMultiple(@Query('ids') ids: string, @Query('evidenceDate') evidenceDate?: string) {
    return this.orderService.getDeliveryCompleteReportMultiple(ids, evidenceDate);
  }

  @ApiOperation({
    summary: '다중 주문 거래명세서 PDF 통합 조회 API',
    description: '여러 주문을 통합하여 거래명세서 조회 (동일 고객사만 가능)',
  })
  @ApiOkResponse({
    description: '성공적으로 조회한 경우',
  })
  // ====================================================
  @Get('/order/order-complete/report-multiple')
  getOrderCompleteReportMultiple(@Query('ids') ids: string, @Query('evidenceDate') evidenceDate?: string) {
    return this.orderService.getOrderCompleteReportMultiple(ids, evidenceDate);
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
    this.logger.log(`createTemp user: ${user.id}, body: ${JSON.stringify(getBody)}`);
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
    summary: '임시저장(TEMP) 소프트 삭제 API',
    description: '임시 저장된 주문의 상태가 TEMP인 경우 soft delete 처리 (deleted_at 업데이트).',
  })
  @ApiOkResponse({
    description: '성공적으로 삭제된 경우',
  })
  @ApiBadRequestResponse({
    description: '존재하지 않거나 임시 상태가 아닌 주문입니다.',
  })
  // ====================================================
  @Delete('/order/temp')
  deleteTemp(@User() user: ILoginUserInfo, @Body() getBody: OrderDeleteTempReqDto): Promise<void> {
    return this.orderService.deleteTemp(user, getBody);
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
    description: '비밀번호 확인 후 엑셀 다운로드를 진행하며, 다운로드 사유와 함께 로그에 기록됩니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 다운로드한 경우',
  })
  // ===================================================
  @Post('/order/excel-download')
  @UseFilters(DownloadExceptionFilter)
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

  @ApiOperation({
    summary: '주문 테스트 발송 API',
    description: '',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 전송한 경우',
  })
  @ApiBadRequestResponse({
    description: '테스트발송은 최대 2회입니다.',
  })
  // ===================================================
  @Post('/order/test-delivery')
  async testDelivery(@User() user: ILoginUserInfo, @Body() getBody: OrderTestDeliveryReqDto) {
    return this.orderService.testDelivery(user, getBody);
  }

  @ApiOperation({
    summary: '이전 발송 문구 불러오기 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: OrderGetPreviousContentResDto,
    description: '성공적으로 전송한 경우',
  })
  // =========================================
  @Get('/order/previous-content')
  async getPreviousContent(@User() user: ILoginUserInfo, @Query() getDto: OrderGetPreviousContentReqQueryDto) {
    return this.orderService.getPreviousContent(user, getDto);
  }

  @ApiOperation({
    summary: '독려문자 설정 수정 API (발송관리용)',
    description: '발송관리에서 독려문자 day를 설정합니다. null이면 미사용.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 수정한 경우',
  })
  @ApiBadRequestResponse({
    description: '존재하지 않는 주문이거나 임시저장 상태인 경우',
  })
  // =========================================
  @Patch('/order/:id/encourage-day')
  async updateEncourageDay(
    @User() user: ILoginUserInfo,
    @Param() getParam: OrderUpdateEncourageDayReqParamDto,
    @Body() getBody: OrderUpdateEncourageDayReqBodyDto,
  ) {
    return this.orderService.updateEncourageDay(user, getParam.id, getBody);
  }

  @ApiOperation({
    summary: '꼬리광고 설정 수정 API (발송관리용)',
    description: '발송관리에서 꼬리광고 텍스트를 설정합니다. null 또는 빈 문자열이면 미사용.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 수정한 경우',
  })
  @ApiBadRequestResponse({
    description: '존재하지 않는 주문이거나 임시저장 상태인 경우',
  })
  // =========================================
  @Patch('/order/:id/tail-text')
  async updateTailText(
    @User() user: ILoginUserInfo,
    @Param() getParam: OrderUpdateTailTextReqParamDto,
    @Body() getBody: OrderUpdateTailTextReqBodyDto,
  ) {
    return this.orderService.updateTailText(user, getParam.id, getBody);
  }

  @ApiOperation({
    summary: '이메일 사용방법 수정 API (발송관리용)',
    description: '발송관리에서 이메일 사용방법을 설정합니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 수정한 경우',
  })
  @ApiBadRequestResponse({
    description: '존재하지 않는 상품 매핑인 경우',
  })
  // =========================================
  @Patch('/order/:id/use-email-content')
  async updateUseEmailContent(
    @User() user: ILoginUserInfo,
    @Param() getParam: OrderUpdateUseEmailContentReqParamDto,
    @Body() getBody: OrderUpdateUseEmailContentReqBodyDto,
  ) {
    return this.orderService.updateUseEmailContent(user, getParam.id, getBody);
  }

  @ApiOperation({
    summary: '주문별 리포트 다운로드 이력 조회 API',
    description: '발송완료리포트 또는 거래명세서의 다운로드 이력을 조회합니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: OrderGetReportHistoryResDto,
    description: '성공적으로 조회한 경우',
  })
  // =========================================
  @Get('/order/:orderId/report-history')
  async getReportHistory(
    @Param() getParam: OrderGetReportHistoryReqParamDto,
    @Query() getQuery: OrderGetReportHistoryReqQueryDto,
  ): Promise<OrderGetReportHistoryResDto> {
    const list = await this.activityLogService.getOrderReportHistory(
      getParam.orderId,
      getQuery.reportType,
    );
    return { list };
  }

  @ApiOperation({
    summary: '발송완료 리포트 이메일 전송 API',
    description: '발송완료 리포트 PDF를 이메일로 전송합니다. 운영관리자 이상만 사용 가능.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 전송한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 order id 가 존재하지 않는 경우',
  })
  // =========================================
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Post('/order/delivery-complete/report/email')
  async sendDeliveryCompleteReportEmail(
    @Body() getBody: OrderDeliveryCompleteReportEmailReqDto,
    @User() user: ILoginUserInfo,
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || '';
    return this.orderService.sendDeliveryCompleteReportEmail(getBody, user, ipAddress);
  }
}
