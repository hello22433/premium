import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { BrandService } from '../application/brand.service';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import {
  BrandCreateReqDto,
  BrandGetDetailReqParamDto,
  BrandGetSearchListReqDto,
  BrandUpdateReqDto,
} from './brand.req.dto';
import { BrandGetDetailResDto, BrandGetSearchListResDto, BrandGetSelectListResDto } from './brand.res.dto';

@ApiTags('brand')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
@Controller('')
export class BrandController {
  constructor(private brandService: BrandService) {}

  @ApiOperation({
    summary: '브랜드 select 조회 API ',
    description: 'select시에 사용하는 브랜드 조회 API 입니다.',
  })
  @ApiOkResponse({
    type: BrandGetSelectListResDto,
    description: '성공적으로 조회한 경우',
  })
  // ===============================================================
  @Get('/brand/select/list')
  getSelectList() {
    return this.brandService.getSelectList();
  }

  @ApiOperation({
    summary: '브랜드 조회 API ',
  })
  @ApiOkResponse({
    type: BrandGetSearchListResDto,
    description: '성공적으로 조회한 경우',
  })
  // ===============================================================
  @Get('/brand/search/list')
  getSearchList(@Query() getQuery: BrandGetSearchListReqDto) {
    return this.brandService.getSearchList(getQuery);
  }

  @ApiOperation({
    summary: '브랜드 detail 조회 API',
  })
  @ApiOkResponse({
    type: BrandGetDetailResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: 'brand 가 존재하지 않는 경우',
  })
  // ===============================================================
  @Get('/brand/detail/:id')
  getDetail(@Param() getParam: BrandGetDetailReqParamDto) {
    return this.brandService.getDetail(getParam);
  }

  @ApiOperation({
    summary: '브랜드 신규 등록 API',
  })
  @ApiOkResponse({ description: '성공적으로 생성된 경우' })
  // ===============================================================
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Post('/brand')
  create(@Body() getBody: BrandCreateReqDto) {
    return this.brandService.create(getBody);
  }

  @ApiOperation({
    summary: '브랜드 신규 수정 API',
  })
  @ApiOkResponse({ description: '성공적으로 수정된 경우' })
  @ApiBadRequestResponse({ description: 'brand 가 존재하지 않는 경우' })
  // ===============================================================
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Put('/brand')
  update(@Body() getBody: BrandUpdateReqDto) {
    return this.brandService.update(getBody);
  }
}
