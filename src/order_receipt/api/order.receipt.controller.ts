import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import fs from 'node:fs';
import { OrderReceiptService } from '../application/order.receipt.service';
import {
  OrderReceiptCreateReqDto,
  OrderReceiptFileDownloadReqQueryDto,
  OrderReceiptGetDetailReqParamDto,
  OrderReceiptGetListReqQueryDto,
  OrderReceiptRejectReqDto,
  OrderReceiptUpdateReqDto,
  OrderReceiptChangeStatusReqDto,
} from './order.receipt.req.dto';
import { OrderReceiptGetDetailResDto, OrderReceiptGetListResDto } from './order.receipt.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { User } from '../../auth/api/user.decorator';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

@ApiTags('order-receipt')
@Controller('')
@UseGuards(AuthUserAuthorizationGuard)
export class OrderReceiptController {
  private readonly logger = new Logger('ORDER_RECEIPT');

  constructor(
    private orderReceiptService: OrderReceiptService,
    private authService: AuthService,
  ) {}

  @ApiOperation({
    summary: '주문접수 list API',
  })
  @ApiOkResponse({
    type: OrderReceiptGetListResDto,
    description: '리스트 조회에 성공한 경우',
  })
  // ===================================================
  @Get('/order-receipt/list')
  async getList(@User() user: ILoginUserInfo, @Query() getQuery: OrderReceiptGetListReqQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.getList(user, getQuery);
  }

  @ApiOperation({
    summary: '주문접수 detail API',
  })
  @ApiOkResponse({
    type: OrderReceiptGetDetailResDto,
    description: '상세 조회에 성공한 경우',
  })
  // ===================================================
  @Get('/order-receipt/:id')
  async getDetail(@User() user: ILoginUserInfo, @Param() getParam: OrderReceiptGetDetailReqParamDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.getDetail(getParam);
  }

  @ApiOperation({
    summary: '주문접수 첨부 다운로드 API',
    description:
      '비공개(private) 저장된 주문접수 첨부를 권한검증 후 백엔드가 스트리밍합니다. ' +
      '다운로드 파일명은 원본명으로 내려갑니다. (운영/최고관리자=전체, 기업관리자=본인 문서만)',
  })
  @ApiOkResponse({ description: '다운로드 성공' })
  @ApiBadRequestResponse({ description: '주문접수/첨부가 존재하지 않는 경우' })
  // ===================================================
  @Get('/order-receipt/:id/file/download')
  async downloadFile(
    @User() user: ILoginUserInfo,
    @Param() getParam: OrderReceiptGetDetailReqParamDto,
    @Query() getQuery: OrderReceiptFileDownloadReqQueryDto,
    @Res() res: Response,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);

    const { fileName, filePath } = await this.orderReceiptService.downloadFile(user, getParam.id, getQuery.fileUrl);

    // 한글 등 비ASCII 는 RFC5987 filename* 로, 구형 클라이언트용 ASCII filename 도 함께 둔다.
    const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    const encodedFileName = encodeURIComponent(fileName);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedFileName}`,
    );

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

    fileStream.on('end', () => fs.unlink(filePath, () => {}));
    fileStream.on('error', (err) => {
      this.logger.error(`주문접수 첨부 스트림 오류: ${err}`);
      fs.unlink(filePath, () => {});
      if (!res.headersSent) {
        res.status(500).json({ message: '파일 다운로드 중 오류가 발생했습니다.' });
      } else {
        res.destroy();
      }
    });
  }

  @ApiOperation({
    summary: '주문접수 등록 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '주문접수 등록에 성공한 경우',
  })
  // ===================================================
  @Post('/order-receipt')
  async create(@User() user: ILoginUserInfo, @Body() getBody: OrderReceiptCreateReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.create(user, getBody);
  }

  @ApiOperation({
    summary: '주문접수 승인 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '주문접수 승인에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문접수 건이 존재하지 않거나 접수 상태가 아닌 경우',
  })
  // ===================================================
  @Put('/order-receipt/:id/approve')
  async approve(@User() user: ILoginUserInfo, @Param() getParam: OrderReceiptGetDetailReqParamDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.approve(user, getParam.id);
  }

  @ApiOperation({
    summary: '주문접수 반려 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '주문접수 반려에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문접수 건이 존재하지 않거나 접수 상태가 아닌 경우',
  })
  // ===================================================
  @Put('/order-receipt/:id/reject')
  async reject(
    @User() user: ILoginUserInfo,
    @Param() getParam: OrderReceiptGetDetailReqParamDto,
    @Body() getBody: OrderReceiptRejectReqDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.reject(user, getParam.id, getBody);
  }

  @ApiOperation({
    summary: '주문접수 상태 변경 API',
    description: '운영관리자 이상만 상태를 자유롭게 변경할 수 있습니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '상태 변경에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문접수 건이 존재하지 않는 경우',
  })
  // ===================================================
  @Patch('/order-receipt/:id/status')
  async changeStatus(
    @User() user: ILoginUserInfo,
    @Param() getParam: OrderReceiptGetDetailReqParamDto,
    @Body() getBody: OrderReceiptChangeStatusReqDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.changeStatus(user, getParam.id, getBody);
  }

  @ApiOperation({
    summary: '주문접수 삭제 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '주문접수 삭제에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문접수 건이 존재하지 않는 경우',
  })
  // ===================================================
  @Delete('/order-receipt/:id')
  async delete(@User() user: ILoginUserInfo, @Param() getParam: OrderReceiptGetDetailReqParamDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.delete(user, getParam.id);
  }

  @ApiOperation({
    summary: '주문접수 수정 API (통합)',
    description:
      '기업관리자 본인(접수 상태): title, filePath, requestNote 수정 가능. ' +
      '운영관리자 이상: confirmNote 수정 가능(상태 무관). ' +
      '각 권한에 해당하는 필드만 전송하면 됩니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '주문접수 수정에 성공한 경우',
  })
  @ApiBadRequestResponse({
    description: '주문접수 건이 존재하지 않거나 수정 권한이 없는 경우',
  })
  // ===================================================
  // Note: PUT /:id 는 /:id/approve, /:id/reject 등 뒤에 배치해야 라우트 충돌 방지
  @Put('/order-receipt/:id')
  async update(
    @User() user: ILoginUserInfo,
    @Param() getParam: OrderReceiptGetDetailReqParamDto,
    @Body() getBody: OrderReceiptUpdateReqDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.ORDER_RECEIPT);
    return this.orderReceiptService.update(user, getParam.id, getBody);
  }
}
