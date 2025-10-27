import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SettleService } from '../application/settle.service';
import { Body, Controller, Get, Logger, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import {
  SettleGetAdminUserListResDto,
  SettleGetMobileListResDto,
  SettleGetOtherDetailResDto,
  SettleGetOtherListResDto,
  SettleGetPartnerCompanyListResDto,
  SettleGetPerUserDetailResDto,
  SettleGetPerUserListResDto,
  SettleGetSaleTypeListResDto,
  SettleGetShippingStorageListResDto,
  SettleGetUserDetailResDto,
  SettleGetUserListResDto,
} from './settle.res.dto';
import {
  SettleCreateOtherSaleReqDto,
  SettleCreateSaleTypeReqDto,
  SettleCreateShippingStorageReqDto,
  SettleGetAdminListReqDto,
  SettleGetMobileListReqQueryDto,
  SettleGetOtherServiceSaleGetDetailReqParamDto,
  SettleGetOtherServiceSaleGetListReqDto,
  SettleGetPartnerCompanyListReqQueryDto,
  SettleGetSaleTypeListReqDto,
  SettleGetShippingStorageListReqDto,
  SettleGetUserDetailReqParamDto,
  SettleGetUserExcelDownloadReqDto,
  SettleGetUserListReqQueryDto,
  SettleGetUserPerDetailReqQueryDto,
  SettleGetUserPerListReqQueryDto,
  SettleMobileExcelDownloadReqDto,
  SettlerUpdateOtherSaleReqDto,
  SettleUpdateUserPerOrderReqDto,
} from './settle.req.dto';
import * as fs from 'fs';
import { Response } from 'express';

@Controller('')
@ApiTags('settle')
@ApiBearerAuth()
@UseGuards(AuthUserSuperAndOperationAdminGuard)
export class SettleController {
  private logger = new Logger('SETTLE');

  constructor(private settleService: SettleService) {}

  @ApiOperation({
    summary: '정산관리 > 기타 서비스 매출 > 리스트 조회 API',
  })
  @ApiOkResponse({
    type: SettleGetOtherListResDto,
  })
  // =====================================
  @Get('settle/other-service-sale/list')
  getOtherList(@Query() getQuery: SettleGetOtherServiceSaleGetListReqDto) {
    return this.settleService.getOtherList(getQuery);
  }

  @ApiOperation({
    summary: '정산관리 > 기타 서비스 매출 > 신규 생성 API',
  })
  @ApiOkResponse({
    description: '성공적으로 생성한 경우',
  })
  // =====================================
  @Post('settle/other-service-sale')
  createOtherServiceSale(@Body() getBody: SettleCreateOtherSaleReqDto) {
    return this.settleService.createOtherServiceSale(getBody);
  }

  @ApiOperation({
    summary: '정산관리 > 기타 서비스 매출 > 수정(매핑 상품 추가 또는 삭제) API',
    description:
      'mappingId 가 있으면 기존 정보를 수정합니다, <br>' +
      '상품 정보 리스트에서 mappingId 가 없이 새로운 값이 들어올 경우 새로운 상품이 매핑 상품에 신규로 추가된 후 저장 됩니다. <br>' +
      'deleteMappingIds 에 있다면 매핑에서 상품을 삭제합니다.',
  })
  @ApiOkResponse({
    description: '성공적으로 생성한 경우',
  })
  // =====================================
  @Put('settle/other-service-sale')
  updateOtherServiceSale(@Body() getBody: SettlerUpdateOtherSaleReqDto) {
    return this.settleService.updateOtherServiceSale(getBody);
  }

  @ApiOperation({
    summary: '정산관리 > 기타 서비스 매출 > 신규 생성 > 출하창고 조회 API',
  })
  @ApiOkResponse({
    type: SettleGetShippingStorageListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =====================================
  @Get('settle/other-service-sale/storage')
  getShippingStorageList(@Query() getQuery: SettleGetShippingStorageListReqDto) {
    return this.settleService.getShippingStorageList(getQuery);
  }

  @ApiOperation({
    summary: '정산관리 > 기타 서비스 매출 > 신규 생성 > 출하창고 생성 API',
  })
  @ApiOkResponse({
    description: '성공적으로 생성한 경우',
  })
  // =====================================
  @Post('settle/other-service-sale/storage')
  createShippingStorage(@Body() body: SettleCreateShippingStorageReqDto) {
    return this.settleService.createShippingStorage(body);
  }

  @ApiOperation({
    summary: '정산관리 > 기타 서비스 매출 > 신규 생성 > 판매유형 생성 API',
  })
  @ApiOkResponse({
    description: '성공적으로 생성한 경우',
  })
  // =====================================
  @Post('settle/other-service-sale/type')
  createSaleType(@Body() body: SettleCreateSaleTypeReqDto) {
    return this.settleService.createSaleType(body);
  }

  @ApiOperation({
    summary: '정산관리 > 기타 서비스 매출 > 신규 생성 > 판매유형 조회 API',
  })
  @ApiOkResponse({
    type: SettleGetSaleTypeListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =====================================
  @Get('settle/other-service-sale/type')
  getSaleTypeList(@Query() getQuery: SettleGetSaleTypeListReqDto) {
    return this.settleService.getSaleTypeList(getQuery);
  }

  @ApiOperation({
    summary: '정산관리 > 기타 서비스 매출 > 신규 생성 > 담당자 리스트 조회 API',
  })
  @ApiOkResponse({
    type: SettleGetAdminUserListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =====================================
  @Get('settle/other-service-sale/admin')
  getAdminUserList(@Query() getQuery: SettleGetAdminListReqDto) {
    return this.settleService.getAdminUserList(getQuery);
  }

  @ApiOperation({
    summary: '정산관리 > 기타 서비스 매출 > 상세조회 API',
  })
  @ApiOkResponse({
    type: SettleGetOtherDetailResDto,
  })
  // =====================================
  @Get('settle/other-service-sale/:id')
  getOtherDetail(@Param() getParam: SettleGetOtherServiceSaleGetDetailReqParamDto) {
    return this.settleService.getOtherDetail(getParam);
  }

  @ApiOperation({
    summary: '정산관리 > 수익률 조회 > 모바일',
  })
  @ApiOkResponse({
    type: SettleGetMobileListResDto,
  })
  // =====================================
  @Get('settle/mobile/list')
  getMobileList(@Query() getQuery: SettleGetMobileListReqQueryDto) {
    return this.settleService.getMobileList(getQuery);
  }

  @ApiOperation({
    summary: '정산관리 > 수익률 조회 > 모바일 엑셀 다운로드 API',
  })
  @ApiOkResponse({
    type: '',
    description: 'response 기존 엑셀 파일 내용 참고',
  })
  // =====================================
  @Post('settle/mobile/excel-download')
  async mobileExcelDownload(@Body() getBody: SettleMobileExcelDownloadReqDto, @Res() res: Response) {
    try {
      const { fileName, filePath } = await this.settleService.mobileExcelDownload(getBody);

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
    summary: '정산관리 > 협력사 정산',
  })
  @ApiOkResponse({
    type: SettleGetPartnerCompanyListResDto,
  })
  // =====================================
  @Get('settle/partner-company/list')
  getPartnerCompanyList(@Query() getQuery: SettleGetPartnerCompanyListReqQueryDto) {
    return this.settleService.getPartnerCompanyList(getQuery);
  }

  @ApiOperation({
    summary: '정산관리 > 고객사 정산',
    description: '고객사 정산 API',
  })
  @ApiOkResponse({
    type: SettleGetUserListResDto,
  })
  // =====================================
  @Get('settle/user/list')
  getUserList(@Query() getQuery: SettleGetUserListReqQueryDto) {
    return this.settleService.getUserList(getQuery);
  }

  @ApiOperation({
    summary: '정산관리 > 고객사 정산 > 상세조회',
    description: '고객사 정산 상세조회 API',
  })
  @ApiOkResponse({
    type: SettleGetUserDetailResDto,
    description: '성공적으로 조회할 경우',
  })
  // =====================================
  @Get('settle/user/:orderId')
  getUserDetail(@Param() getParam: SettleGetUserDetailReqParamDto) {
    return this.settleService.getUserDetail(getParam);
  }

  @ApiOperation({
    summary: '정산관리 > 고객사 정산 엑셀 다운로드 API',
  })
  @ApiOkResponse({
    type: '',
  })
  // =====================================
  @Post('settle/user/excel-download')
  async getUserExcelDownload(
    @Body()
    getBody: SettleGetUserExcelDownloadReqDto,
    @Res()
    res: Response,
  ) {
    try {
      const { fileName, filePath } = await this.settleService.getUserExcelDownload(getBody);

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
    summary: '정산관리 > 정산관리 고객사별 정산관리 목록 list',
    description: '고객사별 정산 관리 (목록)',
  })
  @ApiOkResponse({
    type: SettleGetPerUserListResDto,
  })
  // =====================================
  @Get('settle/user-per/list')
  getUserPerList(@Query() getDto: SettleGetUserPerListReqQueryDto) {
    return this.settleService.getUserPerList(getDto);
  }

  @ApiOperation({
    summary: '정산관리 > 정산관리 고객사별 정산관리 상세 API',
    description: '고객사별 정산 관리 (상세)',
  })
  @ApiOkResponse({
    type: SettleGetPerUserDetailResDto,
  })
  // =====================================
  @Get('settle/user-per/detail')
  getUserPerDetail(@Query() getDto: SettleGetUserPerDetailReqQueryDto) {
    return this.settleService.getUserPerDetail(getDto);
  }

  // 정산관리 고객사별 정산관리 detail 정산상태 update API
  @ApiOperation({
    summary: '정산관리 > 정산관리 고객사별 정산관리 detail 정산상태 update API',
    description: '고객사별 정산 관리 업데이트 API',
  })
  @ApiOkResponse({
    type: '',
  })
  // =====================================
  @Put('settle/user-per/order')
  updateUserPerOrder(@Body() getDto: SettleUpdateUserPerOrderReqDto) {
    return this.settleService.updateUserPerOrder(getDto);
  }
}
