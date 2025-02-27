import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { FileUploadResDto } from '../api/file.res.dto';
import { IFileStorage } from '../interface/file.storage';

@Injectable()
export class FileService {
  constructor(@Inject('IFileStorage') private fileStorage: IFileStorage) {}

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

    const fileReturn = await this.fileStorage.uploadImageFile(file);

    return { url: fileReturn.url };
  }

  async downloadWithPath(path: string, fileTitle: string, fileUrl: string) {
    try {
      const key = fileUrl.split('.com/').slice(1).join('');
      return this.fileStorage.downloadFileToLocalWithPath(path, fileTitle, key);
    } catch (error) {
      throw new Error('올바른 파일 경로가 아닙니다.');
    }
  }
}
