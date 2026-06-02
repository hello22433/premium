import { CustomerServiceService } from '../application/customer.service.service';
import { BadRequestException, Body, Controller, Get, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import {
  CustomerServiceBulkDiscardReqDto,
  CustomerServiceCouponRefreshReqDto,
  CustomerServiceDiscardReqDto,
  CustomerServiceExcelDownloadReqDto,
  CustomerServiceGetDetailListReqDto,
  CustomerServiceGetDetailReqDto,
  CustomerServiceGetListReqDto,
  CustomerServiceHistoryReqDto,
  CustomerServicePinStatusModifyReqDto,
  CustomerServicePinStatusRefreshReqDto,
  CustomerServiceRefundReqDto,
  CustomerServiceReSendReqDto,
  CustomerServiceStatusListReqDto,
  CustomerServiceUnmaskedDeliveryTargetReqDto,
} from './customer.service.req.dto';
import {
  CustomerServiceGetDetailListResDto,
  CustomerServiceGetListResDto,
  CustomerServiceGetDetailResDto,
  CustomerServiceUnmaskedDeliveryTargetResDto,
} from './customer.service.res.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { User } from '../../auth/api/user.decorator';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { AuthService } from '../../auth/application/auth.service';
import { IProductType } from '../../product/interface/product.type';
import { Response } from 'express';

@Controller('')
@ApiTags('customer-service')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
export class CustomerServiceController {
  constructor(
    private customerServiceService: CustomerServiceService,
    private authService: AuthService,
  ) {}

  /**
   * 쿠폰 종류(product.type)에 맞는 CS 권한을 반환한다. (getList 분류 기준과 동일)
   * - SSG → CUSTOMER_SSG_COUPON
   * - GENERAL / CHOICE → CUSTOMER_GENERAL_COUPON
   * - 그 외(DELIVERY/SELF/REAL 등)·누락은 CS 대상이 아니므로 거부 (fail closed)
   */
  private resolveCsCouponAuthority(productType?: IProductType): UserAuthSubEnum {
    if (productType === IProductType.SSG) {
      return UserAuthSubEnum.CUSTOMER_SSG_COUPON;
    }
    if (productType === IProductType.GENERAL || productType === IProductType.CHOICE) {
      return UserAuthSubEnum.CUSTOMER_GENERAL_COUPON;
    }
    throw new BadRequestException('CS 대상이 아닌 상품 유형입니다.');
  }

  @ApiOperation({
    description: '일반쿠폰, 신세계 주문 CS API',
  })
  @ApiOkResponse({
    type: CustomerServiceGetListResDto,
    description: '성공적으로 return 한 경우',
  })
  // ===============================================
  @Get('/customer-service/list')
  async getList(@User() user: ILoginUserInfo, @Query() getQuery: CustomerServiceGetListReqDto) {
    if (getQuery.orderType === 'GENERAL') {
      await this.authService.authorityValidator(user, UserAuthSubEnum.CUSTOMER_GENERAL_COUPON);
    }

    if (getQuery.orderType === 'SSG') {
      await this.authService.authorityValidator(user, UserAuthSubEnum.CUSTOMER_SSG_COUPON);
    }

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
  getDetailList(@User() user: ILoginUserInfo, @Query() getQuery: CustomerServiceGetDetailListReqDto) {
    return this.customerServiceService.getDetailList(user, getQuery);
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
  getDetail(@User() user: ILoginUserInfo, @Query() getQuery: CustomerServiceGetDetailReqDto) {
    return this.customerServiceService.getDetail(user, getQuery);
  }

  @ApiOperation({
    description: '핀상태변경 API',
  })
  @ApiOkResponse({
    description: '성공적으로 return 한 경우',
  })
  // 운영관리자 이상(SUPER_ADMIN·OPERATION_ADMIN) 전용 — 고객사(CORPORATE_ADMIN) 접근 차단
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Put('/customer-service/pin-status/modify')
  async pinStatusModify(@User() user: ILoginUserInfo, @Body() getBody: CustomerServicePinStatusModifyReqDto) {
    // 1. 유효성검사
    await this.customerServiceService.validPinStatusModify(getBody);

    // 2. 데이터매핑
    const map = await this.customerServiceService.mapPinStatusModify(user, getBody);

    // 권한검사: 쿠폰 종류(일반/SSG)에 맞는 CS 권한 확인 (getList 분류 기준과 동일, 그 외 타입은 거부)
    await this.authService.authorityValidator(
      user,
      this.resolveCsCouponAuthority(map.orderDelivery.orderProductMapping?.product?.type),
    );

    // 3. 서비스실행
    return await this.customerServiceService.execPinStatusModify(map);
  }

  @ApiOperation({
    description: '핀상태갱신 API',
  })
  @ApiOkResponse({
    description: '성공적으로 return 한 경우',
  })
  // 운영관리자 이상(SUPER_ADMIN·OPERATION_ADMIN) 전용 — 고객사(CORPORATE_ADMIN) 접근 차단
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Put('/customer-service/pin-status/refresh')
  async pinStatusRefresh(@User() user: ILoginUserInfo, @Body() getBody: CustomerServicePinStatusRefreshReqDto) {
    // 1. 유효성검사
    await this.customerServiceService.validPinStatusRefresh(getBody);

    // 2. 데이터매핑
    const map = await this.customerServiceService.mapPinStatusRefresh(user, getBody);

    // 권한검사: 쿠폰 종류(일반/SSG)에 맞는 CS 권한 확인 (getList 분류 기준과 동일, 그 외 타입은 거부)
    await this.authService.authorityValidator(
      user,
      this.resolveCsCouponAuthority(map.orderDelivery.orderProductMapping?.product?.type),
    );

    // 3. 서비스실행
    return await this.customerServiceService.execPinStatusRefresh(map);
  }

  @ApiOperation({
    description: 'CS 등록 API',
  })
  @ApiOkResponse({
    description: '성공적으로 return 한 경우',
  })
  // 운영관리자 이상(SUPER_ADMIN·OPERATION_ADMIN) 전용 — 고객사(CORPORATE_ADMIN) 접근 차단
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Post('/customer-service/history')
  async history(@User() user: ILoginUserInfo, @Body() getBody: CustomerServiceHistoryReqDto) {
    // 1. 유효성검사
    await this.customerServiceService.validHistory(getBody);

    // 2. 데이터매핑
    const map = await this.customerServiceService.mapHistory(user, getBody);

    // 권한검사: 쿠폰 종류(일반/SSG)에 맞는 CS 권한 확인 (getList 분류 기준과 동일, 그 외 타입은 거부)
    // 이 한 곳에서 모든 type(재전송·수신정보변경·폐기 등)을 일괄 보호한다.
    // (고객사 문의는 별도 채널 QNA가 담당하며, 고객사는 CS 쿠폰 권한이 없어 여기서 자연 차단됨)
    await this.authService.authorityValidator(
      user,
      this.resolveCsCouponAuthority(map.orderDelivery.orderProductMapping?.product?.type),
    );

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
  async statusList(@User() user: ILoginUserInfo, @Query() getQuery: CustomerServiceStatusListReqDto) {
    // 1. 유효성검사
    await this.customerServiceService.validStatusList(getQuery);

    // 2. 데이터매핑 (권한검사 포함)
    const map = await this.customerServiceService.mapStatusList(user, getQuery);

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
  // 운영관리자 이상(SUPER_ADMIN·OPERATION_ADMIN) 전용 — 고객사(CORPORATE_ADMIN) 접근 차단
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Post('/customer-service/pin-discard')
  pinDiscard(@User() user: ILoginUserInfo, @Body() getBody: CustomerServiceDiscardReqDto) {
    return this.customerServiceService.pinDiscard(user, getBody);
  }

  @ApiOperation({ description: '개별 쿠폰 상태 실시간 갱신 API' })
  @ApiOkResponse({ description: '갱신 성공 시 최신 couponStatus 반환' })
  // 운영관리자 이상(SUPER_ADMIN·OPERATION_ADMIN) 전용 — 고객사(CORPORATE_ADMIN) 접근 차단
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Get('/customer-service/coupon/refresh')
  refreshCoupon(@User() user: ILoginUserInfo, @Query() getQuery: CustomerServiceCouponRefreshReqDto) {
    return this.customerServiceService.refreshCoupon(user, getQuery);
  }

  @ApiOperation({
    description: '주문 CS 에서 재발송 API',
  })
  @ApiOkResponse({
    description: '성공적으로 return 한 경우',
  })
  // ===============================================
  // 운영관리자 이상(SUPER_ADMIN·OPERATION_ADMIN) 전용 — 고객사(CORPORATE_ADMIN) 접근 차단
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Post('/customer-service/re-send')
  reSend(@User() user: ILoginUserInfo, @Body() getBody: CustomerServiceReSendReqDto) {
    return this.customerServiceService.reSend(user, getBody);
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

  @ApiOperation({
    description: '고객관리 > 신세계 CS > 이벤트명 상세 > 발송상세 > 환불 API',
  })
  @ApiOkResponse({
    description: '성공적으로 return 한 경우',
  })
  // ===============================================
  // 운영관리자 이상(SUPER_ADMIN·OPERATION_ADMIN) 전용 — 고객사(CORPORATE_ADMIN) 접근 차단
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Put('/customer-service/refund')
  async refund(@User() user: ILoginUserInfo, @Body() getDto: CustomerServiceRefundReqDto) {
    // 권한검사: 환불 관리 권한
    await this.authService.authorityValidator(user, UserAuthSubEnum.CUSTOMER_REFUND);
    return this.customerServiceService.refund(getDto);
  }

  @ApiOperation({
    description: '다중 폐기 API - 선택한 여러 발송 건을 일괄 폐기 처리',
  })
  @ApiOkResponse({
    description: '성공/실패 목록 반환',
    schema: {
      type: 'object',
      properties: {
        success: {
          type: 'array',
          items: { type: 'number' },
          description: '폐기 성공한 orderDeliveryId 목록',
        },
        failed: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              reason: { type: 'string' },
            },
          },
          description: '폐기 실패한 항목과 사유',
        },
      },
    },
  })
  // ===============================================
  // 운영관리자 이상(SUPER_ADMIN·OPERATION_ADMIN) 전용 — 고객사(CORPORATE_ADMIN) 접근 차단
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Post('/customer-service/bulk-discard')
  bulkDiscard(@User() user: ILoginUserInfo, @Body() getBody: CustomerServiceBulkDiscardReqDto) {
    return this.customerServiceService.bulkDiscard(user, getBody.orderDeliveryIds, getBody.content);
  }

  @ApiOperation({
    description: 'CS 리스트 엑셀 다운로드 API - 검색 조건에 맞는 발송 이력을 엑셀 파일로 다운로드',
  })
  @ApiOkResponse({
    description: '엑셀 파일 다운로드',
  })
  // ===============================================
  @Post('/customer-service/excel-download')
  async excelDownload(
    @User() user: ILoginUserInfo,
    @Body() getBody: CustomerServiceExcelDownloadReqDto,
    @Res() res: Response,
  ) {
    if (getBody.orderType === 'GENERAL') {
      await this.authService.authorityValidator(user, UserAuthSubEnum.CUSTOMER_GENERAL_COUPON);
    }

    if (getBody.orderType === 'SSG') {
      await this.authService.authorityValidator(user, UserAuthSubEnum.CUSTOMER_SSG_COUPON);
    }

    return this.customerServiceService.excelDownload(user, getBody, res);
  }
}
