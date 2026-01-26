import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PopularProductService } from '../application/popular.product.service';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { PopularProductGetListResDto } from './popular.product.res.dto';

@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
@ApiTags('popular-product')
@Controller('')
export class PopularProductController {
  constructor(private popularProductService: PopularProductService) {}

  @ApiOperation({
    summary: '주간 인기상품 목록 조회 API',
    description: '최근 7일간 가장 많은 고객사에서 발송한 상품 상위 4개를 조회합니다.',
  })
  @ApiOkResponse({
    type: PopularProductGetListResDto,
    description: '성공적으로 조회한 경우',
  })
  @Get('/popular-product/list')
  getList(): Promise<PopularProductGetListResDto> {
    return this.popularProductService.getList();
  }
}