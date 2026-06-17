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
  ClassificationCreateReqDto,
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
  ProductSharedListUploadReqDto,
  ProductSsgReqQueryDto,
  ProductUpdatePartialReqDto,
} from './product.req.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import {
  ClassificationGetSearchListResDto,
  ProductGetDetailResDto,
  ProductGetListResDto,
  ProductGetSsgResDto,
  ProductSharedListFileResDto,
  ProductGetUpdateHistoryResDto,
} from './product.res.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { User } from '../../auth/api/user.decorator';
import * as fs from 'fs';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { join } from 'path';
import * as process from 'node:process';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { AuthUserSuperAdminGuard } from '../../auth/api/auth.user.super-admin.guard';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';

const PRODUCT_SHARED_LIST_FILE_MAX_SIZE = 10 * 1024 * 1024;

@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
@ApiTags('product')
@Controller('')
export class ProductController {
  constructor(
    private productService: ProductService,
    private activityLogService: ActivityLogService,
    private authService: AuthService,
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
  async getList(@User() user: ILoginUserInfo, @Query() getQuery: ProductGetListReqQueryDto) {
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
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
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
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
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
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
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
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
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
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
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
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Post('/product/excel-upload')
  @UseInterceptors(FileInterceptor('file'))
  excelUpload(@User() user: ILoginUserInfo, @UploadedFile() file: Express.Multer.File) {
    return this.productService.excelUpload(user, file);
  }

  @ApiOperation({
    summary: '상품 엑셀 업로드 API (진행 상황 포함)',
    description: '엑셀 파일을 업로드하여 상품을 등록합니다. SSE로 진행 상황을 전송합니다.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    type: ProductExcelUploadReqDto,
    description: '업로드 하고자 하는 엑셀 파일',
  })
  // =========================================
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Post('/product/excel-upload-with-progress')
  @UseInterceptors(FileInterceptor('file'))
  async excelUploadWithProgress(
    @User() user: ILoginUserInfo,
    @UploadedFile() file: Express.Multer.File,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const sendProgress = (stage: string, current: number, total: number, message?: string) => {
      const data = JSON.stringify({ stage, current, total, message });
      res.write(`data: ${data}\n\n`);
    };

    try {
      const result = await this.productService.excelUploadWithProgress(user, file, sendProgress);
      sendProgress('complete', 100, 100, result.message);
      res.end();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.';
      sendProgress('error', 0, 0, errorMessage);
      res.end();
    }
  }

  @ApiOperation({
    summary: '고객사 공유 상품리스트 파일 업로드 API',
    description: '최고관리자가 업로드한 파일을 고객사가 다운로드할 수 있도록 공유 파일을 등록합니다.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    type: ProductSharedListUploadReqDto,
    description: '업로드 하고자 하는 공유 상품리스트 파일',
  })
  @ApiOkResponse({
    type: ProductSharedListFileResDto,
    description: '성공적으로 업로드한 경우',
  })
  @Post('/product/shared-list-file/upload')
  @UseGuards(AuthUserSuperAdminGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: PRODUCT_SHARED_LIST_FILE_MAX_SIZE,
      },
    }),
  )
  uploadSharedListFile(@User() user: ILoginUserInfo, @UploadedFile() file: Express.Multer.File) {
    return this.productService.uploadSharedListFile(user, file);
  }

  @ApiOperation({
    summary: '고객사 공유 상품리스트 파일 정보 조회 API',
    description: '현재 고객사가 다운로드할 최신 상품리스트 파일 정보를 조회합니다.',
  })
  @ApiOkResponse({
    type: ProductSharedListFileResDto,
    description: '최신 공유 파일 정보를 조회한 경우',
  })
  @Get('/product/shared-list-file')
  getSharedListFile() {
    return this.productService.getSharedListFile();
  }

  @ApiOperation({
    summary: '고객사 공유 상품리스트 파일 다운로드 API',
    description: '최고관리자가 업로드한 최신 상품리스트 파일을 다운로드합니다.',
  })
  @ApiOkResponse({
    description: '성공적으로 다운로드한 경우',
  })
  @Get('/product/shared-list-file/download')
  @UseFilters(DownloadExceptionFilter)
  async downloadSharedListFile(@Res() res: Response) {
    try {
      const { fileName, filePath } = await this.productService.downloadSharedListFile();

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
    summary: '상품 등록 템플릿 엑셀 다운로드 API',
    description: '협력사, 대분류, 브랜드 데이터가 채워진 상품 등록 템플릿을 다운로드합니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 다운로드한 경우',
  })
  // ===================================================
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
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
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
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

  @ApiOperation({
    summary: '대분류 신규 등록 API',
  })
  @ApiOkResponse({
    description: '성공적으로 생성된 경우',
  })
  @ApiBadRequestResponse({
    description: '이미 존재하는 대분류명인 경우',
  })
  // =========================================
  @UseGuards(AuthUserSuperAndOperationAdminGuard)
  @Post('/classification')
  createClassification(@Body() getBody: ClassificationCreateReqDto) {
    return this.productService.createClassification(getBody);
  }
}
