import { Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { FileService } from '../application/file.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { FileUploadImageReqDto, FileUploadPdfReqDto } from './file.req.dto';
import { Express } from 'express';
import { FileUploadResDto } from './file.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { ConfigService } from '@nestjs/config';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';

@ApiTags('file')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
@Controller('')
export class FileController {
  // private readonly logger = new Logger('FILE');

  constructor(
    private fileService: FileService,
    private configService: ConfigService,
  ) {}

  @ApiOperation({
    summary: '이미지 파일 업로드 API',
    description:
      '이미지 파일 업로드를 위한 API 입니다.<br>' +
      'multipart/form-data 형식, key는 imageFile로 전송하시면 됩니다. <br>' +
      'response 값으로 파일의 경로를 드리게 되는데, 해당 경로를 이미지 저장에 있는 API의 값으로 사용하시면 됩니다.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: FileUploadImageReqDto })
  @ApiOkResponse({
    type: FileUploadResDto,
    description: '이미지 파일을 성공적으로 업로드한 경우',
  })
  @ApiBadRequestResponse({
    description: '이미지 파일을 업로드 하지 않은 경우',
  })
  // ============================================
  @UseInterceptors(FileInterceptor('imageFile', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @Post('file/image')
  createImage(@UploadedFile() imageFile: Express.Multer.File) {
    return this.fileService.uploadImageFile(imageFile);
  }

  @ApiOperation({
    summary: 'pdf 파일 업로드 API',
    description:
      'pdf 파일 업로드를 위한 API 입니다.<br>' +
      'multipart/form-data 형식, key는 imageFile로 전송하시면 됩니다. <br>' +
      'response 값으로 파일의 경로를 드리게 되는데, 해당 경로를 이미지 저장에 있는 API의 값으로 사용하시면 됩니다.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: FileUploadPdfReqDto })
  @ApiOkResponse({
    type: FileUploadResDto,
  })
  @ApiBadRequestResponse({})
  // ============================================
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @Post('file/pdf')
  createPdf(@UploadedFile() file: Express.Multer.File) {
    return this.fileService.createPdf(file);
  }

  @ApiOperation({
    summary: '범용 파일 업로드 API',
    description:
      '모든 타입의 파일 업로드를 위한 API 입니다.<br>' +
      'multipart/form-data 형식, key는 file로 전송하시면 됩니다. <br>' +
      'response 값으로 파일의 경로를 드리게 됩니다.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: FileUploadPdfReqDto })
  @ApiOkResponse({
    type: FileUploadResDto,
    description: '파일을 성공적으로 업로드한 경우',
  })
  @ApiBadRequestResponse({
    description: '파일을 업로드 하지 않은 경우',
  })
  // ============================================
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  @Post('file/upload')
  uploadFile(@UploadedFile() file: Express.Multer.File) {
    return this.fileService.uploadFile(file);
  }

  @ApiOperation({
    summary: '비공개 파일 업로드 API',
    description:
      '민감 첨부(주문접수 등)를 위한 비공개 업로드 API 입니다.<br>' +
      'ACL private + 무작위 key 로 저장되어 URL 직접 접근이 불가하며, ' +
      '다운로드는 각 도메인의 백엔드 프록시(권한검증)로만 받습니다.<br>' +
      'multipart/form-data 형식, key는 file로 전송하시면 됩니다.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: FileUploadPdfReqDto })
  @ApiOkResponse({
    type: FileUploadResDto,
    description: '파일을 성공적으로 업로드한 경우',
  })
  @ApiBadRequestResponse({
    description: '파일을 업로드 하지 않은 경우',
  })
  // ============================================
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  @Post('file/upload-private')
  uploadPrivateFile(@UploadedFile() file: Express.Multer.File, @User() user: ILoginUserInfo) {
    // 업로더의 user.id 를 key 에 귀속(private/{userId}/...) → 다운로드 시 소유 검증 가능.
    return this.fileService.uploadPrivateFile(file, user.id);
  }
}
