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
import { pipeline, Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { join } from 'path';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import { resolveDownloadExtension } from '../../util/file.util';

@Injectable()
export class FileStorageS3 implements IFileStorage {
  /**
   * S3 응답 '본문' 이 이 시간 동안 한 바이트도 안 늘면 멈춘 것(stall)으로 보고 끊는다.
   *
   * ★ 왜 우리가 직접 재나 — 클라이언트 옵션(socketTimeout)으로는 못 막는다. SDK 가 그 타이머 등록을
   *   3초 미루고, 응답 헤더가 도착하면 clearTimeouts() 로 예약을 지우기 때문이다(생성자 주석 참조).
   *   pipeline 도 스트림이 '끝나는' 경로만 덮으므로 stall 은 안 덮인다.
   *   남의 라이브러리 내부 타이머 수명에 안전을 걸면 버전만 올라가도 조용히 깨진다.
   */
  static readonly BODY_STALL_TIMEOUT_MS = 30_000;

  /**
   * 청크가 올 때마다 다시 거는 **단발** stall 타이머를 만든다.
   *
   * ★ 처음엔 `setInterval(상한)` 으로 "직전 tick 과 바이트가 같은가" 만 봤다. 그러면 tick 직후에
   *   청크가 오면 다음 tick 이 '진행 있음' 으로 소비되고 그다음 tick 에서야 끊겨,
   *   마지막 진행으로부터 **최대 2배**까지 늦어진다(리뷰 지적, 실측됨).
   *   중간에 '마지막 진행 시각' 을 들고 짧은 주기로 재는 방식도 써 봤지만, 그건 오차를 줄일 뿐이고
   *   여전히 주기만큼 늦다. 청크마다 타이머를 다시 걸면 오차가 아예 없다.
   *
   * @param onStall 상한 동안 진행이 없을 때 부를 것(대개 Body.destroy)
   */
  private createStallWatch(stallMs: number, onStall: () => void) {
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onStall, stallMs);
    };
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    arm();
    return { arm, stop };
  }

  private readonly logger = new Logger(FileStorageS3.name);
  private s3Client: S3Client;

  constructor(private configService: ConfigService) {
    this.s3Client = new S3Client({
      region: this.configService.getOrThrow('AWS_S3_REGION'),
      credentials: {
        accessKeyId: this.configService.getOrThrow('AWS_S3_ACCESS_KEY_ID'),
        secretAccessKey: this.configService.getOrThrow('AWS_S3_SECRET_ACCESS_KEY'),
      },
      // 기본값은 타임아웃이 전부 꺼져 있다(@smithy/node-http-handler 기본 0 = 무제한).
      // 여기서는 '연결 수립' 상한만 건다. 저장소 관례와 같은 30초
      // (HttpModule.register({ timeout: 30000 }) 6곳, 같은 파일의 axios copyImageFromUrl).
      //
      // ⚠️ socketTimeout 은 일부러 안 건다 — 응답 '본문' 이 멈추는 것(stall)을 못 막기 때문이다.
      //   SDK 소스 확인: 값이 6000 이상이면 소켓 타임아웃 등록을 3초 미뤘다가(DEFER_EVENT_LISTENER_TIME)
      //   등록하는데, 응답 헤더가 도착하면 resolve() 가 clearTimeouts() 로 그 예약을 지운다.
      //   S3 가 정상이면 헤더는 1초 안에 오므로 정상일수록 타임아웃이 아예 안 걸린다.
      //   (한때 socketTimeout: 30_000 을 넣고 "stall 을 막았다" 고 적어 뒀었다. 실제로는 안 막혔다.)
      //   본문 stall 방어는 downloadFileToLocalWithPath 가 직접 한다 — 남의 타이머 수명에 안 기댄다.
      // ⚠️ requestTimeout 도 안 된다 — 그건 '총 시간' 이라 대용량 전송·엑셀 파싱을 그대로 끊고,
      //   throwOnRequestTimeout 없이는 경고만 하고 끊지도 않는다.
      requestHandler: { connectionTimeout: 30_000 },
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
      // 업로드 반환 형식(`{bucket}.s3.amazonaws.com`)과 리전 포함 변형(`{bucket}.s3.{region}.amazonaws.com`) 허용.
      //
      // ★ 예전엔 `startsWith(bucket + '.s3.') && endsWith('.amazonaws.com')` 였다. 그러면 **가운데에
      //   무엇이 끼어도 통과**한다 — S3 버킷 이름에는 점을 쓸 수 있으므로, 남이 `epopkon-premium.s3.evil`
      //   이라는 버킷을 만들면 `epopkon-premium.s3.evil.s3.amazonaws.com` 이 우리 것으로 판정됐다(실측).
      //   읽기는 항상 설정의 버킷에서 하므로 남의 버킷을 읽지는 않지만, 그 URL 이 첨부로 **저장**되고
      //   화면에 링크로 렌더되면 우리 도메인처럼 보이는 남의 주소를 고객에게 보내게 된다.
      //   → 리전 자리에 점이 못 들어가게 정규식으로 고정한다(리전은 `ap-northeast-2` 형태).
      const escapedBucket = bucketName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^${escapedBucket}\\.s3(\\.[a-z0-9-]+)?\\.amazonaws\\.com$`).test(hostname);
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
      // ★ for await 도 상대가 멈추면(stall) 영영 안 끝난다 — downloadFileToLocalWithPath 와 같은 구멍이다.
      //   한쪽만 막으면 다른 쪽으로 그대로 샌다(이 호출은 엑셀 자동주문 파싱이 쓴다). 같은 방식으로 막는다:
      //   받은 바이트가 안 늘면 Body 를 끊어 for await 가 던지게 한다.
      const stallMs = FileStorageS3.BODY_STALL_TIMEOUT_MS;
      const stallWatch = this.createStallWatch(stallMs, () =>
        Body.destroy(new Error(`S3 응답 본문이 ${stallMs}ms 동안 진행되지 않아 중단했습니다.`)),
      );

      try {
        for await (const chunk of Body) {
          stallWatch.arm(); // 청크마다 다시 건다 — 여기가 '진행' 의 정의다
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      } finally {
        stallWatch.stop();
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
      // ★ 진행 관측은 pipeline 안의 통과용 Transform 에서 한다.
      //   Body 에 'data' 리스너를 직접 붙이면 flowing 모드로 바뀌어 pipeline 배선 전에 청크가 샌다.
      //   Transform 은 pipeline 이 오류·종료 시 같이 정리해 준다.
      const stallMs = FileStorageS3.BODY_STALL_TIMEOUT_MS;
      const stallWatch = this.createStallWatch(stallMs, () =>
        Body.destroy(new Error(`S3 응답 본문이 ${stallMs}ms 동안 진행되지 않아 중단했습니다.`)),
      );
      const progressWatch = new Transform({
        transform(chunk, _encoding, callback) {
          stallWatch.arm(); // 청크마다 다시 건다
          callback(null, chunk);
        },
      });

      try {
        await new Promise<void>((resolve, reject) => {
          pipeline(Body, progressWatch, writeStream, (err) => (err ? reject(err) : resolve()));
        });
      } catch (error) {
        // pipeline 은 스트림만 정리하고 이미 쓰인 부분 파일은 남긴다. 실패하면 호출자가 경로를 못 받아
        // 정리할 수 없으므로(컨트롤러의 정리는 성공 경로에만 걸린다) 이 자리에서 지운다.
        await this.removeLocalFileQuietly(localFilePath);
        throw error;
      } finally {
        stallWatch.stop();
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
