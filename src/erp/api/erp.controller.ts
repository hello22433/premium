import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { ErpProductService } from '../application/erp.product.service';
import { ErpProductListQueryDto } from './erp.product.query.dto';
import { ErpProductDetailParamDto, ErpProductDetailQueryDto } from './erp.product.detail.dto';
import { ErpProductListResponse } from '../interface/erp.product.response';

@ApiTags('erp')
@ApiBearerAuth()
@UseGuards(AuthUserSuperAndOperationAdminGuard)
@Controller('')
export class ErpController {
  constructor(private readonly erpProductService: ErpProductService) {}

  @ApiOperation({ summary: 'ERP 품목 목록 조회' })
  @Get('/erp/products')
  async getProductsList(@Query() query: ErpProductListQueryDto): Promise<ErpProductListResponse> {
    return this.erpProductService.getProductsList({
      PROD_CD: query.prodCd,
      COMMA_FLAG: query.commaFlag,
      PROD_TYPE: query.prodType,
      FROM_PROD_CD: query.fromProdCd,
      TO_PROD_CD: query.toProdCd,
    });
  }

  @ApiOperation({ summary: 'ERP 품목 단건 조회' })
  @Get('/erp/products/:prodCd')
  async getProduct(
    @Param() param: ErpProductDetailParamDto,
    @Query() query: ErpProductDetailQueryDto,
  ): Promise<ErpProductListResponse> {
    return this.erpProductService.getProduct({
      PROD_CD: param.prodCd,
      PROD_TYPE: query.prodType,
    });
  }
}
