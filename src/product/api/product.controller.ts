import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ProductService } from '../application/product.service';
import { DownloadExceptionFilter } from '../../activity_log/api/download.exception.filter';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
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
  ClassificationGetSearchListReqDto,
  ProductCreateReqDto,
  ProductDeleteReqDto,
  ProductExcelDownloadReqBodyDto,
  ProductExcelUploadReqDto,
  ProductGetDetailReqParamDto,
  ProductGetListReqQueryDto,
  ProductGetTotalListReqQueryDto,
  ProductGetUpdateHistoryReqParamDto,
  ProductGetUpdateHistoryReqQueryDto,
  ProductSetLikeReqDto,
  ProductSsgReqQueryDto,
  ProductUpdatePartialReqDto,
} from './product.req.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import {
  ClassificationGetSearchListResDto,
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
import { join } from 'path';
import * as process from 'node:process';

@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
@ApiTags('product')
@Controller('')
export class ProductController {
  constructor(
    private productService: ProductService,
    private activityLogService: ActivityLogService,
  ) {}

  private logger = new Logger('PRODUCT');

  @ApiOperation({
    summary: '전체 상품 리스트 조회하기 API',
    description: '고객사 관리자인 경우(CORPORATE_ADMIN) 연동되어 있는 상품들만 조회 가능합니다.',
  })
  @ApiOkResponse({
    type: ProductGetListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =========================================
  @Get('/product/total/list')
  getTotalList(@User() user: ILoginUserInfo, @Query() getQuery: ProductGetTotalListReqQueryDto) {
    return this.productService.getTotalList(user, getQuery);
  }

  @ApiOperation({
    summary: '상품 리스트 조회하기 API',
    description: '고객사 관리자인 경우(CORPORATE_ADMIN) 연동되어 있는 상품들만 조회 가능합니다.',
  })
  @ApiOkResponse({
    type: ProductGetListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =========================================
  @Get('/product/list')
  getList(@User() user: ILoginUserInfo, @Query() getQuery: ProductGetListReqQueryDto) {
    return this.productService.getList(user, getQuery);
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
    description: '비밀번호 확인 후 엑셀 다운로드를 진행하며, 다운로드 사유와 함께 로그에 기록됩니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 다운로드한 경우',
  })
  // ===================================================
  @Post('/product/excel-download')
  @UseFilters(DownloadExceptionFilter)
  async excelDownload(
    @User() user: ILoginUserInfo,
    @Body() getBody: ProductExcelDownloadReqBodyDto,
    @Res() res: Response,
  ) {
    try {
      const { fileName, filePath } = await this.productService.excelDownload(user, getBody);

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
  excelUpload(@User() user: ILoginUserInfo, @UploadedFile() file: Express.Multer.File) {
    return this.productService.excelUpload(user, file);
  }

  @ApiOperation({
    summary: '상품 등록 템플릿 엑셀 다운로드 API',
    description: '협력사, 대분류, 브랜드 데이터가 채워진 상품 등록 템플릿을 다운로드합니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 다운로드한 경우',
  })
  // ===================================================
  @Get('/product/excel-template-download')
  @UseFilters(DownloadExceptionFilter)
  async excelTemplateDownload(@Res() res: Response) {
    try {
      const { fileName, fileBuffer } = await this.productService.excelTemplateDownload();

      const encodedFileName = encodeURIComponent(fileName);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.setHeader('Content-Disposition', `attachment; filename=${encodedFileName}`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

      res.send(fileBuffer);
    } catch (e) {
      throw e;
    }
  }

  @ApiOperation({
    summary: '상품 찜하기 API',
  })
  @ApiOkResponse({
    type: '',
    description: '',
  })
  // =========================================
  @Post('/product/like')
  setLike(@User() user: ILoginUserInfo, @Body() getBody: ProductSetLikeReqDto) {
    return this.productService.setLike(user, getBody);
  }
  @ApiOperation({
    summary: '상품관리 > 상품 선택 삭제하기 API',
    description: '',
  })
  @ApiOkResponse({
    type: '',
    description: '',
  })
  // =========================================
  @Delete('/product/list')
  delete(@Body() getDto: ProductDeleteReqDto) {
    return this.productService.delete(getDto);
  }

  @ApiOperation({
    summary: '대분류 조회 API',
    description: '상품 팝업에서 대분류 검색 시 사용합니다.',
  })
  @ApiOkResponse({
    type: ClassificationGetSearchListResDto,
    description: '성공적으로 조회한 경우',
  })
  // =========================================
  @Get('/classification/search/list')
  getClassificationSearchList(@Query() getQuery: ClassificationGetSearchListReqDto) {
    return this.productService.getClassificationSearchList(getQuery);
  }
}
