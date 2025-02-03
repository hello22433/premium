import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ProductService } from '../application/product.service';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ProductCreateReqDto,
  ProductGetDetailReqParamDto,
  ProductGetListReqQueryDto,
  ProductGetUpdateHistoryReqParamDto,
  ProductGetUpdateHistoryReqQueryDto,
  ProductSsgReqQueryDto,
  ProductUpdatePartialReqDto,
} from './product.req.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import {
  ProductGetDetailResDto,
  ProductGetListResDto,
  ProductGetSsgResDto,
  ProductGetUpdateHistoryResDto,
} from './product.res.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { User } from '../../auth/api/user.decorator';

@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
@ApiTags('product')
@Controller('')
export class ProductController {
  constructor(private productService: ProductService) {}

  @ApiOperation({
    summary: '상품 리스트 조회하기 API',
  })
  @ApiOkResponse({
    type: ProductGetListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =========================================
  @Get('/product/list')
  getList(@Query() getQuery: ProductGetListReqQueryDto) {
    return this.productService.getList(getQuery);
  }

  @ApiOperation({
    summary: '신세계 상품권 조회하기 API',
    description: '가격에 일치하는 신세계 상품권 데이터를 return 합니다.',
  })
  @ApiOkResponse({
    type: ProductGetSsgResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '가격이 요구하는 단위가 아닐 경우<br>' + '해당 상품권이 존재하지 않을 경우',
  })
  // =========================================
  @Get('/product/ssg')
  getSsg(@Query() getQuery: ProductSsgReqQueryDto) {
    return this.productService.getSsg(getQuery);
  }

  @ApiOperation({
    summary: '상품 detail API',
  })
  @ApiOkResponse({
    type: ProductGetDetailResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 product 가 존재하지 않는 경우',
  })
  // =========================================
  @Get('/product/detail/:id')
  getDetail(@Param() getParam: ProductGetDetailReqParamDto) {
    return this.productService.getDetail(getParam);
  }

  @ApiOperation({
    summary: '상품 수정 내역 list 불러오기 API',
  })
  @ApiOkResponse({
    type: ProductGetUpdateHistoryResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 product 가 존재하지 않는 경우',
  })
  // =========================================
  @Get('/product/update-history/:id')
  getUpdateHistory(
    @Param() getParam: ProductGetUpdateHistoryReqParamDto,
    @Query() getQuery: ProductGetUpdateHistoryReqQueryDto,
  ) {
    return this.productService.getUpdateHistory(getParam, getQuery);
  }

  @ApiOperation({
    summary: '상품 등록하기 API',
  })
  @ApiOkResponse({
    description: '성공적으로 등록한 경우',
  })
  @ApiBadRequestResponse({
    description: 'brand, partnerCompanyId가 존재하지 않는 경우',
  })
  // =========================================
  @Post('/product')
  create(@Body() getBody: ProductCreateReqDto) {
    return this.productService.create(getBody);
  }

  @ApiOperation({
    summary: '상품 수정하기 API',
    description: '수정하기 시 변경하고자 하는 key 와 value 를 보내주시면 됩니다.',
  })
  @ApiOkResponse({
    description: '성공적으로 수정한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 상품이 존재하지 않는 경우<br>' + 'brand, partnerCompanyId가 존재하지 않는 경우',
  })
  // =========================================
  @Patch('/product')
  updatePartial(@User() user: ILoginUserInfo, @Body() getBody: ProductUpdatePartialReqDto) {
    return this.productService.updatePartial(user, getBody);
  }
}
