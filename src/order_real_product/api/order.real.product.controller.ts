import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Body, Controller, Get, Logger, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { OrderRealProductService } from '../application/order.real.product.service';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { OrderRealProductGetListResDto } from './order.real.product.res.dto';
import {
  OrderRealProductConfirmRequestReqDto,
  OrderRealProductCreateReqDto,
  OrderRealProductDeliveryTrackingReqDto,
  OrderRealProductExcelDownloadReqBodyDto,
  OrderRealProductGetDetailReqParamDto,
  OrderRealProductGetListReqDto,
  OrderRealProductTaxInfoUpdateReqDto,
  OrderRealProductUpdateRequestReqDto,
} from './order.real.product.req.dto';
import { OrderRealProductDetailDto } from './dto/order.real.product.detail.dto';
import * as fs from 'fs';
import { Response } from 'express';

@ApiTags('order-real-product')
@ApiBearerAuth()
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class OrderRealProductController {
  constructor(private orderRealProductService: OrderRealProductService) {}

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
  getList(@User() user: ILoginUserInfo, @Query() getQuery: OrderRealProductGetListReqDto) {
    return this.orderRealProductService.getList(user, getQuery);
  }

  @ApiOperation({
    summary: '실물 상품 주문 API',
  })
  @ApiOkResponse({
    description: '성공적으로 주문한 경우',
  })
  @ApiUnauthorizedResponse({
    description: '최고, 운영 관리자가 아닌 경우',
  })
  // ====================================================
  @Post('/real-product/order')
  order(@User() user: ILoginUserInfo, @Body() getBody: OrderRealProductCreateReqDto) {
    return this.orderRealProductService.order(user, getBody);
  }

  @ApiOperation({
    summary: '실물 상품 주문 상세조회(발주서 조회) API',
  })
  @ApiOkResponse({
    type: OrderRealProductDetailDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문이 존재하지 않을 경우',
  })
  // ====================================================
  @Get('/real-product/order/:id')
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
    description: '고객사 담당자가 아닌 경우',
  })
  // ====================================================
  @Post('/real-product/order/order-confirm')
  orderConfirm(@User() user: ILoginUserInfo, @Body() getBody: OrderRealProductConfirmRequestReqDto) {
    return this.orderRealProductService.orderConfirm(user, getBody);
  }

  @ApiOperation({
    summary: '상품 마지막 배송 상태 조회 API',
    description: '상품의 마지막 배송 상태를 조회합니다. <br>' + '가장 마지막 상태만 조회합니다.',
  })
  @ApiCreatedResponse({
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '올바르지 않은 송장번호를 입력한 경우 <br>' + '올바르지 않은 택배사 id 를 입력한 경우',
  })
  // ====================================================
  @Get('/real-product/order/delivery-track/last')
  getDeliveryTrackingStatus(@User() user: ILoginUserInfo, @Query() getQuery: OrderRealProductDeliveryTrackingReqDto) {
    return this.orderRealProductService.getDeliveryTrackingStatus(user, getQuery);
  }

  @ApiOperation({
    summary: '실물 상품 배송 상세 내역 조회 API',
    description: '상품의 모든 배송 내역을 조회합니다.',
  })
  @ApiCreatedResponse({
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '올바르지 않은 송장번호를 입력한 경우 <br>' + '올바르지 않은 택배사 id 를 입력한 경우',
  })
  // ====================================================
  @Get('/real-product/order/delivery-track/detail')
  getDeliveryTrackingDetail(@User() user: ILoginUserInfo, @Query() getQuery: OrderRealProductDeliveryTrackingReqDto) {
    return this.orderRealProductService.getDeliveryTrackingDetail(user, getQuery);
  }

  @ApiOperation({
    summary: '실물 상품 제세공과금 내역 수정 API',
    description: '상품의 제세공과금 내역을 수정합니다.',
  })
  @ApiCreatedResponse({
    description: '성공적으로 수정한 경우',
  })
  @ApiBadRequestResponse({
    description: '존재하지 않는 주문 번호 인 경우 <br>' + '',
  })
  // ====================================================
  @Patch('/real-product/order/tax')
  updateTaxInfo(@User() user: ILoginUserInfo, @Body() getBody: OrderRealProductTaxInfoUpdateReqDto) {
    return this.orderRealProductService.updateTaxInfo(user, getBody);
  }

  @ApiOperation({
    summary: '실물 상품 주문 및 발송 관리 list 엑셀 다운로드 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 다운로드한 경우',
  })
  // ===================================================
  @Post('/real-product/order/excel-download')
  async excelDownload(
    @User() user: ILoginUserInfo,
    @Body() getBody: OrderRealProductExcelDownloadReqBodyDto,
    @Res() res: Response,
  ) {
    try {
      const { fileName, filePath } = await this.orderRealProductService.excelDownload(user, getBody);

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
