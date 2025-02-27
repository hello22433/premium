import { Body, Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { FileService } from '../application/file.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { FileUploadImageReqDto } from './file.req.dto';
import { Express } from 'express';
import { FileUploadResDto } from './file.res.dto';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { ConfigService } from '@nestjs/config';

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
  @ApiOkResponse({
    type: FileUploadResDto,
    description: '이미지 파일을 성공적으로 업로드한 경우',
  })
  @ApiBadRequestResponse({
    description: '이미지 파일을 업로드 하지 않은 경우',
  })
  // ============================================
  @UseInterceptors(FileInterceptor('imageFile'))
  @Post('file/image')
  createImage(@UploadedFile() imageFile: Express.Multer.File, @Body() dto: FileUploadImageReqDto) {
    return this.fileService.uploadImageFile(imageFile);
  }
}
