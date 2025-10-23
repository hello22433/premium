import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { UserSyncProductService } from '../application/user.sync.product.service';
import {
  UserSyncProductDeleteProductReqDto,
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
  UserSyncProductGetDetailResDto,
  UserSyncProductGetHeadPersonListResDto,
  UserSyncProductGetListResDto,
  UserSyncProductGetPersonsByBusinessResDto,
} from './user.sync.product.res.dto';
import { AuthUserSuperAdminGuard } from '../../auth/api/auth.user.super-admin.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';

@ApiBearerAuth()
@UseGuards(AuthUserSuperAdminGuard)
@ApiTags('user-sync-product')
@Controller('')
export class UserSyncProductController {
  constructor(private userSyncProductService: UserSyncProductService) {}

  @ApiOperation({
    summary: '연동 상품 등록 이벤트 list 조회',
    description: '상품 연동이 완료된 고객사들의 list 를 조회합니다.',
  })
  @ApiOkResponse({
    type: UserSyncProductGetListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =========================================
  @Get('/user-sync-product/list')
  getList(@Query() getQuery: UserSyncProductGetListReqDto) {
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
  @Patch('/user-sync-product/status')
  updateStatus(@Body() getBody: UserSyncProductUpdateStatusReqDto) {
    return this.userSyncProductService.updateStatus(getBody);
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
  @Get('/user-sync-product/detail/:id')
  getDetail(@Param() getParam: UserSyncProductGetDetailReqParamDto) {
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
  @Post('/user-sync-product/event')
  registerEvent(@Body() getBody: UserSyncProductRegisterEventReqDto) {
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
  @Post('/user-sync-product/event/product')
  insertProduct(@Body() getBody: UserSyncProductInsertProductReqDto) {
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
  @Delete('/user-sync-product/product')
  deleteProduct(@Body() getBody: UserSyncProductDeleteProductReqDto) {
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
  @Get('/user-sync-product/head-person/list')
  getHeadPersonList(@Query() getQuery: UserSyncProductGetHeadPersonListReqQueryDto) {
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
  @Get('/user-sync-product/person/list')
  getPersonsByBusinessNumber(@Query() getQuery: UserSyncProductGetPersonsByBusinessReqDto) {
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
  @Patch('/user-sync-product/person/head')
  setHeadPerson(@User() user: ILoginUserInfo, @Body() getBody: UserSyncProductSetHeadPersonReqDto) {
    return this.userSyncProductService.setHeadPerson(user, getBody);
  }
}
