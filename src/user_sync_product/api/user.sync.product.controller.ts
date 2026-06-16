import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { UserSyncProductService } from '../application/user.sync.product.service';
import {
  UserSyncProductDeleteProductReqDto,
  UserSyncProductGetCustomersByProductReqParamDto,
  UserSyncProductGetDetailReqParamDto,
  UserSyncProductGetHeadPersonListReqQueryDto,
  UserSyncProductGetListReqDto,
  UserSyncProductGetPersonsByBusinessReqDto,
  UserSyncProductInsertProductReqDto,
  UserSyncProductRegisterEventReqDto,
  UserSyncProductSetHeadPersonReqDto,
  UserSyncProductUpdateStatusReqDto,
} from './user.sync.product.req.dto';
import {
  UserSyncProductGetCustomersByProductResDto,
  UserSyncProductGetDetailResDto,
  UserSyncProductGetHeadPersonListResDto,
  UserSyncProductGetListResDto,
  UserSyncProductGetPersonsByBusinessResDto,
} from './user.sync.product.res.dto';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { AuthService } from '../../auth/application/auth.service';

@ApiBearerAuth()
@UseGuards(AuthUserSuperAndOperationAdminGuard)
@ApiTags('user-sync-product')
@Controller('user-sync-product')
export class UserSyncProductController {
  constructor(
    private userSyncProductService: UserSyncProductService,
    private authService: AuthService,
  ) {}

  @ApiOperation({
    summary: '연동 상품 등록 이벤트 list 조회',
    description: '상품 연동이 완료된 고객사들의 list 를 조회합니다.',
  })
  @ApiOkResponse({
    type: UserSyncProductGetListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =========================================
  @Get('/list')
  async getList(@User() user: ILoginUserInfo, @Query() getQuery: UserSyncProductGetListReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.PRODUCT_CUSTOMER_LINK_ITEM);
    return this.userSyncProductService.getList(getQuery);
  }

  @ApiOperation({
    summary: '이벤트 연동 상태 수정 API',
    description: '이벤트의 연동 상태를 수정합니다.',
  })
  @ApiOkResponse({
    description: '성공적으로 수정한 경우',
  })
  // =========================================
  @Patch('/status')
  async updateStatus(@User() user: ILoginUserInfo, @Body() getBody: UserSyncProductUpdateStatusReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.PRODUCT_CUSTOMER_LINK_ITEM);
    return this.userSyncProductService.updateStatus(getBody);
  }

  @ApiOperation({
    summary: '상품 기준 사용 고객사 목록 조회 API',
    description: '특정 상품을 사용 중인 고객사(ACTIVE 이벤트) 목록을 조회합니다.',
  })
  @ApiOkResponse({
    type: UserSyncProductGetCustomersByProductResDto,
    description: '성공적으로 조회한 경우',
  })
  // =========================================
  @Get('/product/:productId/customers')
  async getCustomersByProduct(
    @User() user: ILoginUserInfo,
    @Param() getParam: UserSyncProductGetCustomersByProductReqParamDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.PRODUCT_CUSTOMER_LINK_ITEM);
    return this.userSyncProductService.getCustomersByProduct(getParam.productId);
  }

  @ApiOperation({
    summary: '이벤트 연동 상품 list 조회',
    description: '이벤트의 연동되어있는 상품 리스트를 조회합니다.',
  })
  @ApiOkResponse({
    type: UserSyncProductGetDetailResDto,
    description: '성공적으로 조회한 경우',
  })
  // =========================================
  @Get('/detail/:id')
  async getDetail(@User() user: ILoginUserInfo, @Param() getParam: UserSyncProductGetDetailReqParamDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.PRODUCT_CUSTOMER_LINK_ITEM);
    return this.userSyncProductService.getDetail(getParam);
  }

  @ApiOperation({
    summary: '연동 상품 이벤트 등록 API',
    description: '고객사 연동 이벤트를 등록합니다',
  })
  @ApiOkResponse({
    description: '성공적으로 등록한 경우',
  })
  // =========================================
  @Post('/event')
  async registerEvent(@User() user: ILoginUserInfo, @Body() getBody: UserSyncProductRegisterEventReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.PRODUCT_CUSTOMER_LINK_ITEM);
    return this.userSyncProductService.registerEvent(getBody);
  }

  @ApiOperation({
    summary: '이벤트 연동 상품 등록 API',
    description: '생성된 이벤트에 연동 상품을 등록합니다',
  })
  @ApiOkResponse({
    description: '성공적으로 등록한 경우',
  })
  // =========================================
  @Post('/event/product')
  async insertProduct(@User() user: ILoginUserInfo, @Body() getBody: UserSyncProductInsertProductReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.PRODUCT_CUSTOMER_LINK_ITEM);
    return this.userSyncProductService.insertProduct(getBody);
  }

  @ApiOperation({
    summary: '이벤트 연동 상품 삭제 API',
    description: '이벤트의 연동되어있는 상품을 삭제합니다.',
  })
  @ApiOkResponse({
    description: '성공적으로 삭제한 경우',
  })
  // =========================================
  @Delete('/product')
  async deleteProduct(@User() user: ILoginUserInfo, @Body() getBody: UserSyncProductDeleteProductReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.PRODUCT_CUSTOMER_LINK_ITEM);
    return this.userSyncProductService.deleteProduct(getBody);
  }

  @ApiOperation({
    summary: '상품 불러오기 > 고객사의 기본담당자 list 정보 조회 API',
    description: '고객사들의 기본담당자 목록을 조회합니다. 각 고객사의 브랜드수와 등록상품수를 포함합니다.',
  })
  @ApiOkResponse({
    type: UserSyncProductGetHeadPersonListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =========================================
  @Get('/head-person/list')
  async getHeadPersonList(
    @User() user: ILoginUserInfo,
    @Query() getQuery: UserSyncProductGetHeadPersonListReqQueryDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.PRODUCT_CUSTOMER_LINK_ITEM);
    return this.userSyncProductService.getHeadPersonList(getQuery);
  }

  @ApiOperation({
    summary: '회사 담당자 목록 조회 API',
    description: '고객사와 같은 사업자 번호를 가진 모든 담당자를 조회합니다. 기본 담당자가 먼저 표시됩니다.',
  })
  @ApiOkResponse({
    type: UserSyncProductGetPersonsByBusinessResDto,
    description: '성공적으로 조회한 경우',
  })
  // =========================================
  @Get('/person/list')
  async getPersonsByBusinessNumber(
    @User() user: ILoginUserInfo,
    @Query() getQuery: UserSyncProductGetPersonsByBusinessReqDto,
  ) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.PRODUCT_CUSTOMER_LINK_ITEM);
    return this.userSyncProductService.getPersonsByBusinessNumber(getQuery.userId);
  }

  @ApiOperation({
    summary: '기본 담당자 지정 API',
    description:
      '같은 사업자 번호를 가진 담당자 중 한 명을 기본 담당자로 지정합니다. 기존 기본 담당자는 자동으로 해제됩니다.',
  })
  @ApiOkResponse({
    description: '성공적으로 지정한 경우',
  })
  // =========================================
  @Patch('/person/head')
  async setHeadPerson(@User() user: ILoginUserInfo, @Body() getBody: UserSyncProductSetHeadPersonReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.PRODUCT_CUSTOMER_LINK_ITEM);
    return this.userSyncProductService.setHeadPerson(user, getBody);
  }
}
