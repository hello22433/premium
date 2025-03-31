import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UserSyncProductService } from '../application/user.sync.product.service';
import {
  UserSyncProductDeleteProductReqDto,
  UserSyncProductGetDetailReqParamDto,
  UserSyncProductGetListReqDto,
  UserSyncProductInsertProductReqDto,
  UserSyncProductRegisterEventReqDto,
} from './user.sync.product.req.dto';
import { UserSyncProductGetDetailResDto, UserSyncProductGetListResDto } from './user.sync.product.res.dto';
import { AuthUserSuperAdminGuard } from '../../auth/api/auth.user.super-admin.guard';

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
}
