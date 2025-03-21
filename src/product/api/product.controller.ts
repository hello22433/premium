import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ProductService } from '../application/product.service';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ProductCreateReqDto,
  ProductExcelDownloadReqBodyDto,
  ProductExcelUploadReqDto,
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
import * as fs from 'fs';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';

@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
@ApiTags('product')
@Controller('')
export class ProductController {
  constructor(private productService: ProductService) {}

  private logger = new Logger('PRODUCT');

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

  @ApiOperation({
    summary: '상품 엑셀 다운로드 API',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 다운로드한 경우',
  })
  // ===================================================
  @Post('/product/excel-download')
  async excelDownload(@Body() getBody: ProductExcelDownloadReqBodyDto, @Res() res: Response) {
    try {
      const { fileName, filePath } = await this.productService.excelDownload(getBody);

      const encodedFileName = encodeURIComponent(fileName);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.setHeader('Content-Disposition', `attachment; filename=${encodedFileName}`);

      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);

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
    summary: '상품 엑셀 업로드 API',
    description: '엑셀 파일을 업로드하여 상품을 등록합니다.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiOkResponse({
    description: '성공적으로 업로드한 경우',
  })
  @ApiBadRequestResponse({
    description: '상품 등록 과정에서 엑셀 양식이 맞지 않는 경우',
  })
  @ApiBody({
    type: ProductExcelUploadReqDto,
    description: '업로드 하고자 하는 엑셀 파일',
  })
  // =========================================
  @Post('/product/excel-upload')
  @UseInterceptors(FileInterceptor('file'))
  excelUpload(@UploadedFile() file: Express.Multer.File) {
    return this.productService.excelUpload(file);
  }
}
