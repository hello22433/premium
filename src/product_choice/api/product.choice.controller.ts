import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProductChoiceService } from '../application/product.choice.service';
import {
  ProductChoiceCreateReqDto,
  ProductChoiceGetDetailReqParamDto,
  ProductChoiceGetListReqQueryDto,
  ProductChoiceGetProductListReqQueryDto,
  ProductChoiceUpdateReqDto,
} from './product.choice.req.dto';
import {
  ProductChoiceGetDetailResDto,
  ProductChoiceGetListResDto,
  ProductChoiceGetProductListResDto,
} from './product.choice.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { User } from '../../auth/api/user.decorator';
import { AuthService } from '../../auth/application/auth.service';

@ApiTags('product-choice')
@ApiBearerAuth()
// =========================================
@UseGuards(AuthUserAuthorizationGuard)
@Controller('')
export class ProductChoiceController {
  constructor(
    private productChoiceService: ProductChoiceService,
    private authService: AuthService,
  ) {}

  @ApiOperation({
    summary: '초이스쿠폰 리스트 조회하기 API',
  })
  @ApiOkResponse({
    type: ProductChoiceGetListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =========================================
  @Get('/product-choice/list')
  getList(@Query() getQuery: ProductChoiceGetListReqQueryDto): Promise<ProductChoiceGetListResDto> {
    return this.productChoiceService.getList(getQuery);
  }

  @ApiOperation({
    summary: '초이스쿠폰 detail API',
  })
  @ApiOkResponse({
    type: ProductChoiceGetDetailResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '해당 초이스쿠폰 이 존재하지 않는 경우',
  })
  // =========================================
  @Get('/product-choice/detail/:id')
  getDetail(@Param() getParam: ProductChoiceGetDetailReqParamDto) {
    return this.productChoiceService.getDetail(getParam);
  }

  @ApiOperation({
    summary: '초이스쿠폰에 추가할 상품 리스트 조회하기 API',
  })
  @ApiOkResponse({
    type: ProductChoiceGetProductListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =========================================
  @Get('/product-choice/product/list')
  async getProductList(
    @User() user: ILoginUserInfo,
    @Query() getQuery: ProductChoiceGetProductListReqQueryDto,
  ): Promise<ProductChoiceGetProductListResDto> {
    await this.authService.authorityValidator(user, UserAuthSubEnum.PRODUCT_CHOICE);
    return this.productChoiceService.getProductList(getQuery);
  }

  @ApiOperation({
    summary: '초이스쿠폰 상품 등록하기 API',
  })
  @ApiOkResponse({
    description: '성공적으로 등록한 경우',
  })
  @ApiBadRequestResponse({
    description: '존재하지 않거나 삭제된 상품이 있거나 가격이 다른 상품이 포함되어 있는 경우',
  })
  // =========================================
  @Post('/product-choice')
  create(@Body() productChoiceCreateReqDto: ProductChoiceCreateReqDto) {
    return this.productChoiceService.create(productChoiceCreateReqDto);
  }

  @ApiOperation({
    summary: '초이스쿠폰 상품 수정하기 API',
  })
  @ApiOkResponse({
    description: '성공적으로 수정한 경우',
  })
  @ApiBadRequestResponse({
    description:
      '해당 상품이 존재하지 않는 경우<br>' +
      '존재하지 않거나 삭제된 상품이 있거나 가격이 다른 상품이 포함되어 있는 경우',
  })
  // =========================================
  @Put('/product-choice')
  updatePartial(@Body() getBody: ProductChoiceUpdateReqDto) {
    return this.productChoiceService.update(getBody);
  }
}
