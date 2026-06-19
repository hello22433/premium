import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SettleService } from '../application/settle.service';
import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { WalletReadService } from '../../wallet/application/wallet-read.service';
import { SettleBySettlementCodeResDto, SettleSettlementCodeUsageResDto } from './dto/settle.read.res.dto';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { DownloadExceptionFilter } from '../../activity_log/api/download.exception.filter';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import {
  SettleGetAdminUserListResDto,
  SettleGetMobileListResDto,
  SettleGetOtherDetailResDto,
  SettleGetOtherListResDto,
  SettleGetPartnerCompanyListResDto,
  SettleGetPerUserDetailResDto,
  SettleGetPerUserListResDto,
  SettleGetRemainServiceAmountResDto,
  SettleGetSaleTypeListResDto,
  SettleGetShippingStorageListResDto,
  SettleGetUserDetailResDto,
  SettleGetUserDetailMultipleResDto,
  SettleGetUserListResDto,
  SettleGetUserSummaryResDto,
  SettleGetUserIdsResDto,
  SettleGetGalaxiaListResDto,
  SettleBatchConfirmOrdersResDto,
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
  SettleGetUserDetailMultipleReqQueryDto,
  SettlePostUserDetailMultipleReqBodyDto,
  SettleGetUserIdsReqQueryDto,
  SettleGetUserExcelDownloadReqDto,
  SettleGetUserListReqQueryDto,
  SettleGetUserSummaryReqQueryDto,
  SettleGetUserPerDetailReqQueryDto,
  SettleGetUserPerListReqQueryDto,
  SettleMobileExcelDownloadReqDto,
  SettlePartnerCompanyExcelDownloadReqDto,
  SettlerUpdateOtherSaleReqDto,
  SettleUpdateUserPerOrderReqDto,
  SettleGetGalaxiaListReqQueryDto,
  SettleGalaxiaExcelDownloadReqDto,
  SettleBatchConfirmOrdersReqDto,
} from './settle.req.dto';
import { SettleUserDetailMultipleDto } from './dto/settle.user.detail.multiple.dto';
import * as fs from 'fs';
import { Request, Response } from 'express';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { AuthService } from '../../auth/application/auth.service';

@Controller('')
@ApiTags('settle')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
export class SettleController {
  private logger = new Logger('SETTLE');

  constructor(
    private settleService: SettleService,
    private activityLogService: ActivityLogService,
    private authService: AuthService,
    private walletReadService: WalletReadService,
  ) {}

  @ApiOperation({
    summary: '정산관리 > 정산코드 단위 잔액 스냅샷 조회 API',
    description: '고객사(companyId)의 정산코드별 현재 wallet 잔액/포인트 잔액. wallet 미존재 정산코드는 walletStatus=MISSING.',
  })
  @ApiOkResponse({ type: SettleBySettlementCodeResDto })
  @Get('settle/by-settlement-code')
  async getBySettlementCode(
    @User() user: ILoginUserInfo,
    @Query('companyId', ParseIntPipe) companyId: number,
  ): Promise<SettleBySettlementCodeResDto> {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_USER_MANAGE);
    return this.walletReadService.getSettlementCodeSnapshot(companyId);
  }

  @ApiOperation({
    summary: '정산관리 > 정산코드 단위 기간 wallet 결제액 조회 API',
    description:
      '정산코드별 기간 allocation 집계(walletPaidAmount). 기간 기준 = wallet 차감/발송확정 시점. legacy "정산확정액"과 다른 지표이므로 합산 금지.',
  })
  @ApiOkResponse({ type: SettleSettlementCodeUsageResDto })
  @Get('settle/by-settlement-code/usage')
  async getBySettlementCodeUsage(
    @User() user: ILoginUserInfo,
    @Query('companyId', ParseIntPipe) companyId: number,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('includeReleased') includeReleased?: string,
  ): Promise<SettleSettlementCodeUsageResDto> {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_USER_MANAGE);
    return this.walletReadService.getSettlementCodeUsage(companyId, from, to, includeReleased === 'true');
  }

  @ApiOperation({
    summary: '정산관리 > 기타 서비스 매출 > 리스트 조회 API',
  })
  @ApiOkResponse({
    type: SettleGetOtherListResDto,
  })
  // =====================================
  @Get('settle/other-service-sale/list')
  async getOtherList(@User() user: ILoginUserInfo, @Query() getQuery: SettleGetOtherServiceSaleGetListReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SERVICE_SALES);
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
  async getMobileList(@User() user: ILoginUserInfo, @Query() getQuery: SettleGetMobileListReqQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.PROFIT);
    return this.settleService.getMobileList(getQuery);
  }

  @ApiOperation({
    summary: '정산관리 > 수익률 조회 > 모바일 엑셀 다운로드 API',
    description: '비밀번호 확인 후 엑셀 다운로드를 진행하며, 다운로드 사유와 함께 로그에 기록됩니다.',
  })
  @ApiOkResponse({
    type: '',
    description: 'response 기존 엑셀 파일 내용 참고',
  })
  // =====================================
  @Post('settle/mobile/excel-download')
  @UseFilters(DownloadExceptionFilter)
  async mobileExcelDownload(
    @User() user: ILoginUserInfo,
    @Body() getBody: SettleMobileExcelDownloadReqDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.PROFIT);
    try {
      const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || '';
      const userAgent = req.headers['user-agent'] || '';
      const { fileName, filePath } = await this.settleService.mobileExcelDownload(user, getBody, ipAddress, userAgent);

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
    summary: '정산관리 > 협력사 정산',
  })
  @ApiOkResponse({
    type: SettleGetPartnerCompanyListResDto,
  })
  // =====================================
  @Get('settle/partner-company/list')
  async getPartnerCompanyList(@User() user: ILoginUserInfo, @Query() getQuery: SettleGetPartnerCompanyListReqQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_COMPANY);
    return this.settleService.getPartnerCompanyList(getQuery);
  }

  @ApiOperation({
    summary: '정산관리 > 협력사 정산 > 엑셀 다운로드',
  })
  // =====================================
  @UseFilters(DownloadExceptionFilter)
  @Post('settle/partner-company/excel-download')
  async partnerCompanyExcelDownload(
    @User() user: ILoginUserInfo,
    @Body() body: SettlePartnerCompanyExcelDownloadReqDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_COMPANY);
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || '';
    const userAgent = req.headers['user-agent'] || '';
    const { fileName, filePath } = await this.settleService.partnerCompanyExcelDownload(user, body, ipAddress, userAgent);
    res.download(filePath, fileName, (err) => {
      if (err) {
        this.logger.error(`Error downloading file: ${err}`);
      }
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) {
          this.logger.error(`파일 삭제 실패: ${unlinkErr}`);
        }
      });
    });
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
  async getUserList(@User() user: ILoginUserInfo, @Query() getQuery: SettleGetUserListReqQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_USER);
    return this.settleService.getUserList(getQuery);
  }

  @ApiOperation({
    summary: '정산관리 > 고객사 정산 > 합계 조회',
    description: '검색 조건에 해당하는 전체 발송수량/발송금액/정산금액 합계를 반환 (필터 변경 시에만 호출)',
  })
  @ApiOkResponse({
    type: SettleGetUserSummaryResDto,
  })
  // =====================================
  @Get('settle/user/summary')
  async getUserSummary(@User() user: ILoginUserInfo, @Query() getQuery: SettleGetUserSummaryReqQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_USER);
    return this.settleService.getUserSummary(getQuery);
  }

  @ApiOperation({
    summary: '정산관리 > 고객사 정산 > ID 목록 조회',
    description: '검색 조건에 해당하는 모든 주문의 ID + 최소 메타정보를 반환하는 경량 API (최대 1,000건)',
  })
  @ApiOkResponse({
    type: SettleGetUserIdsResDto,
  })
  // =====================================
  @Get('settle/user/ids')
  async getUserIds(@User() user: ILoginUserInfo, @Query() getQuery: SettleGetUserIdsReqQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_USER);
    return this.settleService.getUserIds(getQuery);
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
  async getUserDetail(@User() user: ILoginUserInfo, @Param() getParam: SettleGetUserDetailReqParamDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_USER);
    return this.settleService.getUserDetail(getParam);
  }

  @ApiOperation({
    summary: '정산관리 > 고객사 정산 > 다중 상세조회',
    description: '여러 주문을 통합하여 조회 (동일 고객사만 가능)',
  })
  @ApiOkResponse({
    type: SettleGetUserDetailMultipleResDto,
    description: '성공적으로 조회할 경우',
  })
  // =====================================
  @Get('settle/user-multiple')
  async getUserDetailMultiple(@User() user: ILoginUserInfo, @Query() getQuery: SettleGetUserDetailMultipleReqQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_USER);
    return this.settleService.getUserDetailMultiple(getQuery);
  }

  @ApiOperation({
    summary: '정산관리 > 고객사 정산 > 다중 상세조회 (POST)',
    description: '여러 주문을 통합하여 조회 (동일 고객사만 가능, 최대 1,000건)',
  })
  @ApiOkResponse({
    type: SettleGetUserDetailMultipleResDto,
    description: '성공적으로 조회할 경우',
  })
  // =====================================
  @Post('settle/user-multiple')
  async postUserDetailMultiple(@User() user: ILoginUserInfo, @Body() body: SettlePostUserDetailMultipleReqBodyDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_USER);
    return this.settleService.getUserDetailMultipleByBody(body);
  }

  @ApiOperation({
    summary: '정산관리 > 고객사 정산 엑셀 다운로드 API',
    description: '비밀번호 확인 후 엑셀 다운로드를 진행하며, 다운로드 사유와 함께 로그에 기록됩니다.',
  })
  @ApiOkResponse({
    type: '',
  })
  // =====================================
  @Post('settle/user/excel-download')
  @UseFilters(DownloadExceptionFilter)
  async getUserExcelDownload(
    @User() user: ILoginUserInfo,
    @Body()
    getBody: SettleGetUserExcelDownloadReqDto,
    @Req() req: Request,
    @Res()
    res: Response,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_USER);
    try {
      const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || '';
      const userAgent = req.headers['user-agent'] || '';
      const { fileName, filePath, recordCount } = await this.settleService.getUserExcelDownload(user, getBody, ipAddress, userAgent);

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
    summary: '정산관리 > 정산관리 고객사별 정산관리 목록 list',
    description: '고객사별 정산 관리 (목록)',
  })
  @ApiOkResponse({
    type: SettleGetPerUserListResDto,
  })
  // =====================================
  @Get('settle/user-per/list')
  async getUserPerList(@User() user: ILoginUserInfo, @Query() getDto: SettleGetUserPerListReqQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_USER_MANAGE);
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
  async updateUserPerOrder(@User() user: ILoginUserInfo, @Body() getDto: SettleUpdateUserPerOrderReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_USER_MANAGE);
    return this.settleService.updateUserPerOrder(getDto);
  }

  @ApiOperation({
    summary: '정산관리 > 고객사별 정산관리 > 일괄 확정 API',
    description: '선택된 미정산 건들을 일괄로 정산완료(SETTLE_COMPLETE)로 변경',
  })
  @ApiOkResponse({
    type: SettleBatchConfirmOrdersResDto,
  })
  // =====================================
  @Put('settle/user-per/orders/batch-confirm')
  async batchConfirmUserPerOrders(
    @User() user: ILoginUserInfo,
    @Body() body: SettleBatchConfirmOrdersReqDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_USER_MANAGE);
    return this.settleService.batchConfirmUserPerOrders(body.orderIds);
  }

  @ApiOperation({
    summary: '정산관리 > 갤럭시아 정산',
    description: '갤럭시아 사용내역 기준 정산 목록 (appDay 기준 필터링)',
  })
  @ApiOkResponse({
    type: SettleGetGalaxiaListResDto,
  })
  // =====================================
  @Get('settle/galaxia/list')
  async getGalaxiaList(@User() user: ILoginUserInfo, @Query() getQuery: SettleGetGalaxiaListReqQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_COMPANY);
    return this.settleService.getGalaxiaList(getQuery);
  }

  @ApiOperation({
    summary: '정산관리 > 갤럭시아 정산 > 엑셀 다운로드',
    description: '갤럭시아 사용내역 기준 엑셀 다운로드 (appDay 기준 필터링)',
  })
  // =====================================
  @UseFilters(DownloadExceptionFilter)
  @Post('settle/galaxia/excel-download')
  async galaxiaExcelDownload(
    @User() user: ILoginUserInfo,
    @Body() body: SettleGalaxiaExcelDownloadReqDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_PARTNER_COMPANY);
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || '';
    const userAgent = req.headers['user-agent'] || '';
    const { fileName, filePath } = await this.settleService.galaxiaExcelDownload(user, body, ipAddress, userAgent);
    res.download(filePath, fileName, (err) => {
      if (err) {
        this.logger.error(`Error downloading file: ${err}`);
      }
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) {
          this.logger.error(`파일 삭제 실패: ${unlinkErr}`);
        }
      });
    });
  }
}
