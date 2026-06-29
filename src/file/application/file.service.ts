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
      const key = this.extractStorageKey(fileUrl);
      return this.fileStorage.downloadFileToLocalWithPath(path, fileTitle, key);
    } catch (error) {
      throw new Error('올바른 파일 경로가 아닙니다.');
    }
  }

  async createPdf(file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('not exist pdf file');
    }

    // 한글 깨짐 방지
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');

    if (file.mimetype !== 'application/pdf') {
      throw new BadRequestException('PDF 파일만 업로드 가능합니다.');
    }

    const fileReturn = await this.fileStorage.uploadFile(file);

    return { url: fileReturn.url };
  }

  async uploadFile(file: Express.Multer.File): Promise<FileUploadResDto> {
    if (!file) {
      throw new BadRequestException('파일이 존재하지 않습니다.');
    }

    // 한글 깨짐 방지
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');

    const fileReturn = await this.fileStorage.uploadFile(file);

    return { url: fileReturn.url };
  }

  /**
   * 비공개(private) 업로드. ACL private + 무작위 key 로 저장한다.
   * 직접 객체 접근이 안 되고 백엔드 프록시(자격증명 GetObject)로만 받는, 민감 첨부용.
   */
  async uploadPrivateFile(file: Express.Multer.File): Promise<FileUploadResDto> {
    if (!file) {
      throw new BadRequestException('파일이 존재하지 않습니다.');
    }

    // 한글 깨짐 방지
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');

    const fileReturn = await this.fileStorage.uploadPrivateFile(file);

    return { url: fileReturn.url };
  }

  /**
   * S3 URL → 사용자에게 보여줄 원본 파일명 복원.
   * 키 마지막 세그먼트가 `{무작위식별자}-{원본명}` 이므로 첫 '-' 뒤를 원본명으로 본다.
   * 신키(private/{uuid}-원본명)·구키(file/{Date.now}-원본명) 모두 동일하게 복원된다
   * (식별자에 '-' 가 없도록 표준화돼 있어 안전).
   */
  extractOriginalFileName(fileUrl: string): string {
    const key = this.extractStorageKey(fileUrl);
    const base = key.split('/').pop() || '';
    return base.includes('-') ? base.split('-').slice(1).join('-') : base;
  }

  private extractStorageKey(fileUrl: string): string {
    const parsedUrl = new URL(fileUrl);
    return decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''));
  }
}
