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
import { maskStorageKeyForLog, sanitizeForLog } from '../../util/file.util';

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
      // ★ key 를 그대로 쓰면 안 된다 — `private/{업로더id}/{uuid}-{원본명}` 이라 접근 로그에서 가려 놓은
      //   원본명이 여기로 다시 샌다(같은 값을 한쪽 채널에서만 가리는 꼴). 그리고 key 는 클라이언트가 준
      //   URL 을 decode 한 값이라 `%0a` 로 개행을 넣어 가짜 로그 줄을 만들 수 있다.
      //   → maskStorageKeyForLog 가 마스킹과 제어문자 제거를 둘 다 한다(그 함수 주석 참조).
      //   메시지·code 도 같은 이유로 정제한다 — SDK 메시지에 key 가 그대로 실릴 수 있고, code 는 외부
      //   SDK 가 채우는 값이라 형태 보장이 없다.
      const rawMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `S3 다운로드 실패 (key=${maskStorageKeyForLog(key)}, code=${sanitizeForLog(
          this.resolveErrorCode(error),
        )}): ${sanitizeForLog(rawMessage)}`,
        error instanceof Error ? sanitizeForLog(error.stack ?? '') : undefined,
      );
      if (this.isNotFoundError(error)) {
        throw new NotFoundException('파일을 찾을 수 없습니다.');
      }
      // 인증/네트워크/스로틀 등은 서버측 원인 → 500(원인은 위 로그로 관측). "경로 오류"로 오도하지 않는다.
      throw new InternalServerErrorException('파일 다운로드 중 오류가 발생했습니다.');
    }
  }

  /**
   * S3 '객체 없음' 판별 — GetObject 는 NoSuchKey, HeadObject 는 NotFound 를 준다.
   *
   * ★ 404 만으로 판정하면 안 된다: NoSuchBucket 도 HTTP 404 라 버킷 설정이 깨진 인프라 장애가
   *   사용자에게 "파일을 찾을 수 없습니다" 로 나가고, 500 이면 울릴 경보가 404 라 안 울린다.
   *   그래서 코드가 있으면 코드로만 판정하고, 코드가 없는 경우에만 404 를 폴백으로 쓴다.
   */
  private isNotFoundError(error: unknown): boolean {
    const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    // ★ name 과 Code 를 '둘 다' 본다. `e.name ?? e.Code` 로 하나만 고르면, JS Error 는 name 이 항상
    //   채워져 있어(new Error('x').name === 'Error') Code 분기가 영영 안 읽힌다. 실제로 그렇게 썼다가
    //   Code 에만 코드가 실린 에러가 404 → 500 으로 바뀌는 회귀를 냈다(SDK 래핑·구버전 shape).
    const NOT_FOUND_CODES = new Set(['NoSuchKey', 'NotFound']);
    if (NOT_FOUND_CODES.has(e?.name ?? '') || NOT_FOUND_CODES.has(e?.Code ?? '')) {
      return true;
    }
    // 코드가 하나라도 있으면 그게 답이다. NoSuchBucket 도 HTTP 404 라 404 단독 판정은 금지.
    if (e?.name || e?.Code) {
      return false;
    }
    // 코드가 아예 없는 형태에서만 404 폴백.
    return e?.$metadata?.httpStatusCode === 404;
  }

  /**
   * 로그에 남길 에러 코드 문자열.
   *
   * ★ `e.name ?? e.Code` 로 쓰면 안 된다 — JS Error 는 name 이 항상 채워져 있어(new Error('x').name === 'Error')
   *   Code 분기가 영영 안 읽힌다. isNotFoundError 가 그 회귀를 겪고 두 축을 다 보게 고쳤는데, 정작 로그는
   *   같은 패턴을 그대로 쓰고 있었다 → 버킷 오설정(Code=NoSuchBucket)이 로그엔 `code=Error` 로만 보였다.
   *   그래서 있는 것을 다 이어 붙인다(`Error/NoSuchBucket`). 어느 쪽도 조용히 버리지 않는다.
   */
  private resolveErrorCode(error: unknown): string {
    const e = error as { name?: string; Code?: string };
    const codes = [e?.name, e?.Code].filter((v): v is string => typeof v === 'string' && v.length > 0);
    return codes.length === 0 ? 'unknown' : [...new Set(codes)].join('/');
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
    } catch (error) {
      // 객체가 없는 것(NotFound/NoSuchKey)은 레거시 첨부의 정상 폴백이라 조용히 넘긴다.
      // 그 외(권한·자격증명·버킷 오설정·네트워크)는 '원본명 기능이 통째로 꺼진' 상태인데 응답은 200 이라
      // 아무 신호도 안 선다 → 반드시 남긴다. key 는 원본명이 새지 않게 마스킹해서 남긴다.
      // ★ '객체 없음' 판정은 isNotFoundError 로 통일한다. 여기서 `e.name ?? e.Code` 로 따로 판정하면
      //   Code 에만 코드가 실린 에러가 name='Error' 에 가려 정상 폴백인데도 warn 이 나간다(그 반대도 마찬가지).
      //   같은 질문에 답이 두 개면 언젠가 갈린다.
      // ★ key 뿐 아니라 code·message 도 정제한다 — 셋 다 외부에서 온 값이고, 한 곳만 빼면 그리로 샌다.
      if (!this.isNotFoundError(error)) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `원본명 메타데이터 조회 실패 — key 복원으로 폴백 (key=${maskStorageKeyForLog(key)}, code=${sanitizeForLog(
            this.resolveErrorCode(error),
          )}): ${sanitizeForLog(rawMessage)}`,
        );
      }
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
