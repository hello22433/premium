import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Body, Controller, Get, Logger, Param, Post, Put, Query, Res, UseFilters, UseGuards } from '@nestjs/common';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { OrderRealProductService } from '../application/order.real.product.service';
import { DownloadExceptionFilter } from '../../activity_log/api/download.exception.filter';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import {
  OrderRealProductGetAdminListResDto,
  OrderRealProductGetDeliveryCompleteReportResDto,
  OrderRealProductGetDeliveryTrackDetailResDto,
  OrderRealProductGetDeliveryTrackingLastEventResDto,
  OrderRealProductGetDetailResDto,
  OrderRealProductGetListResDto,
  OrderRealProductGetSettlementListResDto,
  OrderRealProductMappingGetDetailResDto,
} from './order.real.product.res.dto';
import {
  OrderRealProductConfirmRequestReqDto,
  OrderRealProductCreateReqDto,
  OrderRealProductDeliveryTrackingGetDetailReqParamDto,
  OrderRealProductDeliveryTrackingReqDto,
  OrderRealProductExcelDownloadReqBodyDto,
  OrderRealProductGetAdminListReqDto,
  OrderRealProductGetDeliveryCompleteReportReqDto,
  OrderRealProductGetDetailReqParamDto,
  OrderRealProductGetListReqDto,
  OrderRealProductGetSettlementExcelDownloadReqDto,
  OrderRealProductGetSettlementListReqDto,
  OrderRealProductMappingGetDetailReqParamDto,
  OrderRealProductMappingUpdateReqDto,
  OrderRealProductUpdateReqDto,
  OrderRealProductUpdateRequestReqDto,
} from './order.real.product.req.dto';
import * as fs from 'fs';
import { Response } from 'express';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { AuthUserSuperAdminGuard } from '../../auth/api/auth.user.super-admin.guard';
import { IOrderSection } from '../../order/interface/order.section';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

@ApiTags('order-real-product')
@ApiBearerAuth()
@Controller('')
export class OrderRealProductController {
  constructor(
    private orderRealProductService: OrderRealProductService,
    private activityLogService: ActivityLogService,
    private authService: AuthService,
  ) {}

  private logger = new Logger('REAL_PRODUCT_ORDER');

  @ApiOperation({
    summary: '실물 상품 주문 및 발송 관리 list API',
  })
  @ApiOkResponse({
    type: OrderRealProductGetListResDto,
    description: '성공적으로 조회한 경우',
  })
  // ====================================================
  @Get('/real-product/order/list')
  @UseGuards(AuthUserAuthorizationGuard)
  async getList(@User() user: ILoginUserInfo, @Query() getQuery: OrderRealProductGetListReqDto) {
    if (getQuery.section === IOrderSection.ORDER) {
      await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_REAL_ITEM);
    }

    if (getQuery.section === IOrderSection.SHIPPING) {
      await this.authService.authorityValidator(user, UserAuthSubEnum.SEND_REAL_ITEM);
    }

    return this.orderRealProductService.getList(user, getQuery);
  }

  @ApiOperation({
    summary: '담당자 리스트 조회 API',
  })
  @ApiOkResponse({
    type: OrderRealProductGetAdminListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =====================================
  @Get('/real-product/order/admin/list')
  @UseGuards(AuthUserAuthorizationGuard)
  getAdminUserList(@Query() getQuery: OrderRealProductGetAdminListReqDto) {
    return this.orderRealProductService.getAdminUserList(getQuery);
  }

  @ApiOperation({
    summary: '실물 상품 주문 API',
  })
  @ApiOkResponse({
    description: '성공적으로 주문한 경우',
  })
  // ====================================================
  @Post('/real-product/order')
  @UseGuards(AuthUserAuthorizationGuard)
  order(@User() user: ILoginUserInfo, @Body() getBody: OrderRealProductCreateReqDto) {
    return this.orderRealProductService.order(user, getBody);
  }

  @ApiOperation({
    summary: '실물 상품 주문 상세조회(발주서 조회) API',
  })
  @ApiOkResponse({
    type: OrderRealProductGetDetailResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문이 존재하지 않을 경우',
  })
  // ====================================================
  @Get('/real-product/order/:id')
  @UseGuards(AuthUserAuthorizationGuard)
  getDetail(@User() user: ILoginUserInfo, @Param() getParam: OrderRealProductGetDetailReqParamDto) {
    return this.orderRealProductService.getDetail(user, getParam);
  }

  @ApiOperation({
    summary: '주문 수정 요청 API',
    description: '확정된 주문을 수정 요청합니다. ',
  })
  @ApiCreatedResponse({
    description: '성공적으로 확정한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문이 존재하지 않을 경우',
  })
  @ApiUnauthorizedResponse({
    description: '고객사 담당자가 아닌 경우',
  })
  // ====================================================
  @Post('/real-product/order/update-request')
  @UseGuards(AuthUserAuthorizationGuard)
  updateRequest(@User() user: ILoginUserInfo, @Body() getBody: OrderRealProductUpdateRequestReqDto) {
    return this.orderRealProductService.updateRequest(user, getBody);
  }

  @ApiOperation({
    summary: '주문 수정 요청 승인 API',
    description: '주문 완료된 주문을 수정 요청합니다. ',
  })
  @ApiCreatedResponse({
    description: '성공적으로 승인한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문이 존재하지 않을 경우',
  })
  @ApiUnauthorizedResponse({
    description: '최고, 운영관리자가 아닌 경우',
  })
  // ====================================================
  @Post('/real-product/order/update-approve')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  updateApprove(@User() user: ILoginUserInfo, @Body() getBody: OrderRealProductUpdateRequestReqDto) {
    return this.orderRealProductService.updateApprove(user, getBody);
  }

  @ApiOperation({
    summary: '주문 확정 API',
    description: '주문 완료된 주문을 확정합니다. ',
  })
  @ApiCreatedResponse({
    description: '성공적으로 주문 확정한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문이 존재하지 않을 경우',
  })
  @ApiBadRequestResponse({
    description: '최고 관리자가 아닌 경우',
  })
  // ====================================================
  @Post('/real-product/order/order-confirm')
  @UseGuards(AuthUserSuperAdminGuard)
  orderConfirm(@Body() getBody: OrderRealProductConfirmRequestReqDto) {
    return this.orderRealProductService.orderConfirm(getBody);
  }

  @ApiOperation({
    summary: '실물상품 주문 > 배송 조회 API',
  })
  @ApiCreatedResponse({
    type: OrderRealProductGetDeliveryTrackingLastEventResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '올바르지 않은 송장번호를 입력한 경우 <br>' + '올바르지 않은 택배사 id 를 입력한 경우',
  })
  // ====================================================
  @Get('/real-product/order/delivery-track/last')
  @UseGuards(AuthUserAuthorizationGuard)
  getDeliveryTrackingStatus(@User() user: ILoginUserInfo, @Query() getQuery: OrderRealProductDeliveryTrackingReqDto) {
    return this.orderRealProductService.getDeliveryTrackingStatus(user, getQuery);
  }

  @ApiOperation({
    summary: '실물상품 주문 > 배송 상세 조회 API',
  })
  @ApiCreatedResponse({
    type: OrderRealProductGetDeliveryTrackDetailResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '올바르지 않은 송장번호를 입력한 경우 <br>' + '올바르지 않은 택배사 id 를 입력한 경우',
  })
  // ====================================================
  @Get('/real-product/order/delivery-track/detail/:id')
  @UseGuards(AuthUserAuthorizationGuard)
  getDeliveryTrackingDetail(
    @User() user: ILoginUserInfo,
    @Param() getParam: OrderRealProductDeliveryTrackingGetDetailReqParamDto,
  ) {
    return this.orderRealProductService.getDeliveryTrackingDetail(user, getParam);
  }

  @ApiOperation({
    summary: '실물 상품 주문 수정 API',
    description: '실물 상품의 확정된 주문을 수정합니다.',
  })
  @ApiCreatedResponse({
    description: '성공적으로 수정한 경우',
  })
  @ApiBadRequestResponse({
    description: '존재하지 않는 주문 번호 인 경우 <br>' + '',
  })
  // ====================================================
  @Put('/real-product/order')
  @UseGuards(AuthUserAuthorizationGuard)
  update(@User() user: ILoginUserInfo, @Body() getBody: OrderRealProductUpdateReqDto) {
    return this.orderRealProductService.update(user, getBody);
  }

  @ApiOperation({
    summary: '실물 상품 정산 정보(수익률 조회) list API',
    description: '실물 상품의 정산 정보를 조회합니다.',
  })
  @ApiCreatedResponse({
    type: OrderRealProductGetSettlementListResDto,
    description: '성공적으로 조회한 경우',
  })
  // ====================================================
  @Get('/real-product/settle')
  @UseGuards(AuthUserAuthorizationGuard)
  getSettlement(@User() user: ILoginUserInfo, @Query() getQuery: OrderRealProductGetSettlementListReqDto) {
    return this.orderRealProductService.getSettlement(user, getQuery);
  }

  @ApiOperation({
    summary: '실물 상품 발송 완료 리포트 PDF 주문 상세 조회 API',
  })
  @ApiOkResponse({
    type: OrderRealProductGetDeliveryCompleteReportResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 order id 가 존재하지 않는 경우',
  })
  // ====================================================
  @Get('/real-product/order/delivery-complete/report')
  @UseGuards(AuthUserAuthorizationGuard)
  getDeliveryCompleteReport(@User() user: ILoginUserInfo, @Query() getQuery: OrderRealProductGetDeliveryCompleteReportReqDto) {
    return this.orderRealProductService.getDeliveryCompleteReport(user, getQuery);
  }

  @ApiOperation({
    summary: '정산관리 > 수익률 조회 > 기타 엑셀 다운로드 API',
    description: '비밀번호 확인 후 엑셀 다운로드를 진행하며, 다운로드 사유와 함께 로그에 기록됩니다.',
  })
  @ApiCreatedResponse({
    type: '',
  })
  // ====================================================
  @Post('/real-product/settle/excel-download')
  @UseFilters(DownloadExceptionFilter)
  @UseGuards(AuthUserAuthorizationGuard)
  async settleExcelDownload(
    @User() user: ILoginUserInfo,
    @Body() getBody: OrderRealProductGetSettlementExcelDownloadReqDto,
    @Res() res: Response,
  ) {
    try {
      const { fileName, filePath } = await this.orderRealProductService.settleExcelDownload(user, getBody);

      const encodedFileName = encodeURIComponent(fileName);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.setHeader('Content-Disposition', `attachment; filename=${encodedFileName}`);

      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);

      fileStream.on('error', (err) => {
        this.logger.error(`파일 스트림 오류: ${err}`);
        fs.unlink(filePath, () => {});
        if (!res.headersSent) {
          res.status(500).json({ message: '파일 다운로드 중 오류가 발생했습니다.' });
        } else {
          res.destroy();
        }
      });

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
    summary: '실물 상품 주문 및 발송 관리 list 엑셀 다운로드 API',
    description: '비밀번호 확인 후 엑셀 다운로드를 진행하며, 다운로드 사유와 함께 로그에 기록됩니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 다운로드한 경우',
  })
  // ===================================================
  @Post('/real-product/order/excel-download')
  @UseFilters(DownloadExceptionFilter)
  @UseGuards(AuthUserAuthorizationGuard)
  async excelDownload(
    @User() user: ILoginUserInfo,
    @Body() getBody: OrderRealProductExcelDownloadReqBodyDto,
    @Res() res: Response,
  ) {
    if (getBody.section === IOrderSection.ORDER) {
      await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_REAL_ITEM);
    }

    if (getBody.section === IOrderSection.SHIPPING) {
      await this.authService.authorityValidator(user, UserAuthSubEnum.SEND_REAL_ITEM);
    }

    try {
      const { fileName, filePath } = await this.orderRealProductService.excelDownload(user, getBody);

      const encodedFileName = encodeURIComponent(fileName);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.setHeader('Content-Disposition', `attachment; filename=${encodedFileName}`);

      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);

      fileStream.on('error', (err) => {
        this.logger.error(`파일 스트림 오류: ${err}`);
        fs.unlink(filePath, () => {});
        if (!res.headersSent) {
          res.status(500).json({ message: '파일 다운로드 중 오류가 발생했습니다.' });
        } else {
          res.destroy();
        }
      });

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
    summary: '실물 발송 관리 발주 상품 내역 자세히 보기 API',
    description: '',
  })
  @ApiOkResponse({
    type: OrderRealProductMappingGetDetailResDto,
    description: '',
  })
  @ApiBadRequestResponse({
    description: '주문이 존재하지 않을 경우',
  })
  // ====================================================
  @Get('/real-product/order/order-product-mapping/detail/:id')
  @UseGuards(AuthUserAuthorizationGuard)
  getOrderProductMappingDetail(@User() user: ILoginUserInfo, @Param() getParam: OrderRealProductMappingGetDetailReqParamDto) {
    return this.orderRealProductService.getOrderProductMappingDetail(user, getParam);
  }

  @ApiOperation({
    summary: '주문 확정 API',
    description: '주문 완료된 주문을 확정합니다. ',
  })
  @ApiCreatedResponse({
    description: '성공적으로 주문 확정한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문이 존재하지 않을 경우',
  })
  @ApiBadRequestResponse({
    description: '최고 관리자가 아닌 경우',
  })
  // ====================================================
  @Put('/real-product/order/order-product-mapping')
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  updateOrderProductMappingDetail(@Body() getBody: OrderRealProductMappingUpdateReqDto) {
    return this.orderRealProductService.updateOrderProductMappingDetail(getBody);
  }
}
