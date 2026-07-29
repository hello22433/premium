import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FileUploadResDto } from '../api/file.res.dto';
import { IFileStorage } from '../interface/file.storage';

@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

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

  async downloadWithPath(path: string, fileTitle: string, fileUrl: string): Promise<string> {
    let key: string;
    try {
      key = this.extractStorageKey(fileUrl);
    } catch {
      // URL 형식이 아니면 호출자(클라이언트) 입력 문제 → 400.
      throw new BadRequestException('올바른 파일 경로가 아닙니다.');
    }

    try {
      // 과거엔 await 없이 return 해 S3 비동기 실패가 이 catch 를 우회했다(원본 에러가 raw 500 으로 노출).
      // await 로 실제로 잡아, 원인을 로그로 남기고 상태를 구분해 던진다.
      return await this.fileStorage.downloadFileToLocalWithPath(path, fileTitle, key);
    } catch (error) {
      this.logger.error(
        `S3 다운로드 실패 (key=${key}): ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      if (this.isNotFoundError(error)) {
        throw new NotFoundException('파일을 찾을 수 없습니다.');
      }
      // 인증/네트워크/스로틀 등은 서버측 원인 → 500(원인은 위 로그로 관측). "경로 오류"로 오도하지 않는다.
      throw new InternalServerErrorException('파일 다운로드 중 오류가 발생했습니다.');
    }
  }

  /** S3(GetObject) '객체 없음' 판별 — AWS SDK v3 에러/HTTP 메타의 여러 형태에 대응. */
  private isNotFoundError(error: unknown): boolean {
    const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    return e?.name === 'NoSuchKey' || e?.Code === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
  }

  /** S3 URL 의 객체를 메모리 버퍼로 읽는다(엑셀 파싱 등 서버 내 처리용). */
  async getBuffer(fileUrl: string): Promise<Buffer> {
    const key = this.extractStorageKey(fileUrl);
    return this.fileStorage.getFileBuffer(key);
  }

  /** S3 객체 크기(바이트)를 본문 다운로드 없이 조회(못 구하면 null). 대용량 파일을 getBuffer 전에 거르는 용도. */
  async getContentLength(fileUrl: string): Promise<number | null> {
    const key = this.extractStorageKey(fileUrl);
    return this.fileStorage.headContentLength(key);
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
  async uploadPrivateFile(file: Express.Multer.File, ownerId?: number): Promise<FileUploadResDto> {
    if (!file) {
      throw new BadRequestException('파일이 존재하지 않습니다.');
    }

    // 한글 깨짐 방지
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');

    const fileReturn = await this.fileStorage.uploadPrivateFile(file, ownerId);

    return { url: fileReturn.url };
  }

  /**
   * 다운로드/표시에 쓸 "진짜 원본 파일명".
   * 1순위: 객체 메타데이터(originalname, verbatim) → 공백·특수문자까지 정확.
   * 폴백: 메타데이터가 없는 레거시 객체는 key 에서 sanitize 된 이름 복원(extractOriginalFileName).
   */
  async getOriginalName(fileUrl: string): Promise<string> {
    const key = this.extractStorageKey(fileUrl);
    try {
      const metaName = await this.fileStorage.headOriginalName(key);
      if (metaName) {
        return metaName;
      }
    } catch {
      // 메타데이터 조회 실패(레거시/누락) → key 기반 폴백
    }
    return this.extractOriginalFileNameFromKey(key);
  }

  /**
   * S3 URL → key 에서 원본 파일명을 복원(폴백용).
   * 키 마지막 세그먼트가 `{무작위식별자}-{원본명}` 이므로 첫 '-' 뒤를 원본명으로 본다.
   * 신키(private/{uuid}-원본명)·구키(file/{Date.now}-원본명) 모두 호환.
   * 단 key 는 sanitize 돼 있어(공백→_) 진짜 원본과 다를 수 있다 → 메타데이터 우선.
   */
  extractOriginalFileName(fileUrl: string): string {
    return this.extractOriginalFileNameFromKey(this.extractStorageKey(fileUrl));
  }

  private extractOriginalFileNameFromKey(key: string): string {
    const base = key.split('/').pop() || '';
    return base.includes('-') ? base.split('-').slice(1).join('-') : base;
  }

  extractStorageKey(fileUrl: string): string {
    const parsedUrl = new URL(fileUrl);
    return decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''));
  }

  /** 우리 S3 버킷의 객체 URL 인지(host 기준). 외부 host URL 차단용. */
  isOwnStorageUrl(fileUrl: string): boolean {
    return this.fileStorage.isOwnStorageUrl(fileUrl);
  }
}
