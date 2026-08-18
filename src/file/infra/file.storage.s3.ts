import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IFileStorage, IFileUploadFileReturn } from '../interface/file.storage';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  PutObjectCommandInput,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { pipeline } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { join } from 'path';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import { resolveDownloadExtension } from '../../util/file.util';

@Injectable()
export class FileStorageS3 implements IFileStorage {
  private readonly logger = new Logger(FileStorageS3.name);
  private s3Client: S3Client;

  constructor(private configService: ConfigService) {
    this.s3Client = new S3Client({
      region: this.configService.getOrThrow('AWS_S3_REGION'),
      credentials: {
        accessKeyId: this.configService.getOrThrow('AWS_S3_ACCESS_KEY_ID'),
        secretAccessKey: this.configService.getOrThrow('AWS_S3_SECRET_ACCESS_KEY'),
      },
      // ★ 기본값은 타임아웃이 전부 꺼져 있다(@smithy/node-http-handler 기본 0 = 무제한). 그러면 상대가
      //   데이터도 오류도 안 주고 멈출 때(stall) 응답 Promise 가 영영 끝나지 않는다 — pipeline 은 스트림이
      //   '끝나는' 경로만 덮으므로 이건 안 덮인다. 부분 임시파일·소켓·요청 컨텍스트가 무기한 남는다.
      //   같은 파일의 axios(copyImageFromUrl)와 저장소 관례(HttpModule.register({ timeout: 30000 }) 6곳)에
      //   맞춰 30초. 이 파일에서 S3Client 만 상한이 없던 비대칭을 없앤다.
      //
      // ⚠️ requestTimeout 을 쓰면 안 된다 — 그건 '총 시간' 이라 대용량 업로드/다운로드(20MB 상한)와
      //   엑셀 파싱(getBuffer)을 그대로 끊는다. 게다가 throwOnRequestTimeout 없이는 경고만 하고 안 끊는다.
      //   여기서 필요한 건 '무응답 시간' 이고 그게 socketTimeout 이다(데이터가 흐르는 한 안 걸린다).
      requestHandler: { connectionTimeout: 30_000, socketTimeout: 30_000 },
    });
  }

  private sanitizeFileName(name: string): string {
    return name.replace(/[#?%\s/\\]/g, '_');
  }

  /**
   * 키 접두사로 쓰는 무작위 식별자. 하이픈 없는 UUID(32 hex) 로 통일한다.
   *  - Date.now() 대비: 시각 기반 추측/열거(brute-force) 차단(UUIDv4 = 122비트).
   *  - 하이픈 제거 이유: 다운로드/표시단이 키를 `{식별자}-{원본명}` 으로 보고 첫 '-' 기준으로
   *    원본명을 복원하므로(FE 5곳 + 다운로드 프록시), 식별자 안에 '-' 가 있으면 복원이 깨진다.
   */
  private randomKey(): string {
    return randomUUID().replace(/-/g, '');
  }

  async uploadImageFile(file: Express.Multer.File): Promise<IFileUploadFileReturn> {
    const bucketName = this.configService.getOrThrow('AWS_S3_BUCKET');

    const uploadFileName = `image/${this.randomKey()}-${this.sanitizeFileName(file.originalname)}`;

    const fileData: PutObjectCommandInput = {
      Bucket: bucketName,
      Key: uploadFileName,
      Body: file.buffer,
      ACL: 'public-read',
    };

    try {
      const command = new PutObjectCommand(fileData);
      await this.s3Client.send(command);

      return {
        url: `https://${bucketName}.s3.amazonaws.com/${uploadFileName}`,
        originalName: file.originalname,
      };
    } catch (e) {
      throw new Error(e as any);
    }
  }

  async uploadFile(file: Express.Multer.File): Promise<IFileUploadFileReturn> {
    const bucketName = this.configService.getOrThrow('AWS_S3_BUCKET');

    const uploadFileName = `file/${this.randomKey()}-${this.sanitizeFileName(file.originalname)}`;

    const fileData: PutObjectCommandInput = {
      Bucket: bucketName,
      Key: uploadFileName,
      Body: file.buffer,
      ACL: 'public-read',
    };

    try {
      const command = new PutObjectCommand(fileData);
      await this.s3Client.send(command);

      return {
        url: `https://${bucketName}.s3.amazonaws.com/${uploadFileName}`,
        originalName: file.originalname,
      };
    } catch (e) {
      throw new Error(e as any);
    }
  }

  async uploadPrivateFile(file: Express.Multer.File, ownerId?: number): Promise<IFileUploadFileReturn> {
    const bucketName = this.configService.getOrThrow('AWS_S3_BUCKET');

    // 비공개 저장 + 무작위(UUID) key. 다운로드는 백엔드가 자격증명으로 GetObject 하므로 public-read 불필요.
    // UUID 로 "업로드 시각 + 원본 파일명" 추측 접근을 차단한다.
    // ownerId 가 있으면 `private/{ownerId}/...` 로 소유자를 key 에 귀속(다운로드 시 소유 검증용).
    const prefix = ownerId != null ? `private/${ownerId}` : 'private';
    const uploadFileName = `${prefix}/${this.randomKey()}-${this.sanitizeFileName(file.originalname)}`;

    const fileData: PutObjectCommandInput = {
      Bucket: bucketName,
      Key: uploadFileName,
      Body: file.buffer,
      ACL: 'private',
      // 진짜 원본명을 메타데이터에 verbatim 보존(key 는 URL 안전 위해 sanitize 됨).
      // S3 메타데이터는 ASCII 만 허용 → 한글 등은 encodeURIComponent 로 감싼다(읽을 때 decode).
      Metadata: { originalname: encodeURIComponent(file.originalname) },
    };

    try {
      const command = new PutObjectCommand(fileData);
      await this.s3Client.send(command);

      return {
        url: `https://${bucketName}.s3.amazonaws.com/${uploadFileName}`,
        originalName: file.originalname,
      };
    } catch (e) {
      throw new Error(e as any);
    }
  }

  async headOriginalName(key: string): Promise<string | null> {
    const bucketName = this.configService.getOrThrow('AWS_S3_BUCKET');
    const res = await this.s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    const raw = res.Metadata?.originalname;
    return raw ? decodeURIComponent(raw) : null;
  }

  async headContentLength(key: string): Promise<number | null> {
    const bucketName = this.configService.getOrThrow('AWS_S3_BUCKET');
    const res = await this.s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    return typeof res.ContentLength === 'number' ? res.ContentLength : null;
  }

  isOwnStorageUrl(fileUrl: string): boolean {
    const bucketName = this.configService.getOrThrow('AWS_S3_BUCKET');
    try {
      const { hostname } = new URL(fileUrl);
      // 업로드 반환 형식(`{bucket}.s3.amazonaws.com`)과 리전 포함 변형(`{bucket}.s3.{region}.amazonaws.com`) 허용
      return (
        hostname === `${bucketName}.s3.amazonaws.com` ||
        (hostname.startsWith(`${bucketName}.s3.`) && hostname.endsWith('.amazonaws.com'))
      );
    } catch {
      return false;
    }
  }

  async uploadImageFileWithBuffer(
    buffer: Buffer,
    fileName: string,
    originalName: string,
  ): Promise<IFileUploadFileReturn> {
    const bucketName = this.configService.getOrThrow('AWS_S3_BUCKET');

    const fileData: PutObjectCommandInput = {
      Bucket: bucketName,
      Key: fileName,
      Body: buffer,
      ACL: 'public-read',
    };

    try {
      const command = new PutObjectCommand(fileData);
      await this.s3Client.send(command);

      return {
        url: `https://${bucketName}.s3.amazonaws.com/${fileName}`,
        originalName: originalName,
      };
    } catch (e) {
      throw new Error(e as any);
    }
  }

  async getFileBuffer(key: string): Promise<Buffer> {
    const bucketName = this.configService.getOrThrow('AWS_S3_BUCKET');
    const { Body } = await this.s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));

    if (Body instanceof Readable) {
      const chunks: Buffer[] = [];
      for await (const chunk of Body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    // AWS SDK v3 SdkStream 헬퍼 폴백(웹 스트림 환경)
    const sdkBody = Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (typeof sdkBody?.transformToByteArray === 'function') {
      return Buffer.from(await sdkBody.transformToByteArray());
    }
    throw new Error('S3 Body is not a readable stream');
  }

  async downloadFileToLocalWithPath(path: string, fileTitle: string, downloadPath: string): Promise<string> {
    const bucketName = this.configService.getOrThrow('AWS_S3_BUCKET');

    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: downloadPath,
    });

    const { Body } = await this.s3Client.send(command);

    if (Body instanceof Readable) {
      // 확장자: key 마지막 세그먼트에 '.' 이 있을 때만. 없으면 'bin'(과거엔 경로 전체가 확장자가 되어 ENOENT 500).
      const extension = resolveDownloadExtension(downloadPath);

      const localFilePath = join(path, fileTitle + `.${extension}`);
      const writeStream = fs.createWriteStream(localFilePath);

      // pipeline 은 성공/소스오류/대상오류 등 스트림이 '끝나는' 경로에서 콜백을 1회 호출하고 두 스트림을
      // 정리한다. (컨트롤러의 스트리밍과 같은 관례 — user.drive.controller / order.receipt.controller)
      // 과거엔 Body.pipe(writeStream) 뒤 writeStream 의 finish/error 만 들었다. 그러면 S3 Body 가
      // 전송 도중 끊길 때(네트워크 리셋 등) ① Promise 가 영영 settle 되지 않아 요청이 매달리고
      // ② 소스 오류가 uncaughtException 으로 튀어 프로세스가 죽을 수 있었다. 실측으로 둘 다 재현됨.
      //
      // ⚠️ '모든' 경우가 덮이는 것은 아니다 — 상대가 데이터도 오류도 안 주고 멈추는 것(stall)은 애초에
      //    '끝나는' 경로가 아니라서 pipeline 이 못 본다. 그리고 이 S3Client 는 requestHandler 를 안 줘서
      //    connection/request/socket 타임아웃이 전부 꺼져 있다(@smithy/node-http-handler 기본값 0 = 무제한).
      //    그러면 이 Promise 가 영영 settle 되지 않고 부분 임시파일·소켓이 무기한 남는다.
      //    타임아웃 값은 같은 클라이언트를 쓰는 대용량 업로드·엑셀 파싱(getBuffer)에 영향이 있어
      //    운영 판단이 필요하다 → 후속 과제 문서 참조.
      try {
        await new Promise<void>((resolve, reject) => {
          pipeline(Body, writeStream, (err) => (err ? reject(err) : resolve()));
        });
      } catch (error) {
        // pipeline 은 스트림만 정리하고 이미 쓰인 부분 파일은 남긴다. 실패하면 호출자가 경로를 못 받아
        // 정리할 수 없으므로(컨트롤러의 정리는 성공 경로에만 걸린다) 이 자리에서 지운다.
        await this.removeLocalFileQuietly(localFilePath);
        throw error;
      }

      return localFilePath;
    }
    throw new Error('Body is not a readable stream');
  }

  /** 실패 경로의 부분 파일 정리. 이미 없으면(ENOENT) 조용히 넘어가고, 그 외 실패만 누수로 경고한다. */
  private removeLocalFileQuietly(localFilePath: string): Promise<void> {
    return new Promise((resolve) => {
      fs.unlink(localFilePath, (unlinkErr) => {
        if (unlinkErr && (unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.logger.warn(`S3 다운로드 실패분 임시파일 삭제 실패(누수 가능): ${localFilePath} — ${unlinkErr.message}`);
        }
        resolve();
      });
    });
  }

  async copyImageFromUrl(imageUrl: string, safeIp: string): Promise<IFileUploadFileReturn> {
    const bucketName = this.configService.getOrThrow('AWS_S3_BUCKET');

    // 원본 URL을 그대로 사용해 SNI/인증서 검증을 정상 유지하고, 실제 TCP 연결만 검증된 IP로 강제
    const family = safeIp.includes(':') ? 6 : 4;
    const lookup = (
      _hostname: string,
      _options: unknown,
      callback: (err: Error | null, addr: string, family: number) => void,
    ) => {
      callback(null, safeIp, family);
    };
    const httpAgent = new http.Agent({ lookup } as http.AgentOptions);
    const httpsAgent = new https.Agent({ lookup } as https.AgentOptions);

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxRedirects: 0,
      httpAgent,
      httpsAgent,
    });

    const buffer = Buffer.from(response.data);

    const urlPath = new URL(imageUrl).pathname;
    const originalName = decodeURIComponent(urlPath.split('/').pop() || 'image.jpg');

    // S3 업로드 경로 생성
    const uploadFileName = `image/${this.randomKey()}-${this.sanitizeFileName(originalName)}`;

    const fileData: PutObjectCommandInput = {
      Bucket: bucketName,
      Key: uploadFileName,
      Body: buffer,
      ACL: 'public-read',
    };

    try {
      const command = new PutObjectCommand(fileData);
      await this.s3Client.send(command);

      return {
        url: `https://${bucketName}.s3.amazonaws.com/${uploadFileName}`,
        originalName: originalName,
      };
    } catch (e) {
      throw new Error(`이미지 복사 실패: ${e}`);
    }
  }
}
