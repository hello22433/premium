import { BadRequestException, Injectable } from '@nestjs/common';
import { FileUploadResDto } from '../api/file.res.dto';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class FileService {
  constructor(private configService: ConfigService) {}

  async uploadImageFile(file: Express.Multer.File): Promise<FileUploadResDto> {
    if (!file) {
      throw new BadRequestException('not exist image file');
    }

    // 한글 깨짐 방지
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');

    const mime = file.mimetype;

    if (!mime.startsWith('image/')) {
      throw new BadRequestException('NO_IMAGE_FILE_TYPE');
    }

    // const fileReturn = await this.fileStorage.uploadImageFile(file);

    const serverHost = this.configService.getOrThrow('SERVER_HOST');
    const uploadImageFilePath = this.configService.getOrThrow('SERVER_IMAGE_PATH');

    const fileUrl = `${serverHost}${uploadImageFilePath}/${file.filename}`;

    return { url: fileUrl };
  }
}
