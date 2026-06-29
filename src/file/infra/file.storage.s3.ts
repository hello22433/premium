import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IFileStorage, IFileUploadFileReturn } from '../interface/file.storage';
import { GetObjectCommand, PutObjectCommand, PutObjectCommandInput, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { randomUUID } from 'node:crypto';
import { join } from 'path';
import process from 'node:process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import axios from 'axios';

@Injectable()
export class FileStorageS3 implements IFileStorage {
  private s3Client: S3Client;

  constructor(private configService: ConfigService) {
    this.s3Client = new S3Client({
      region: this.configService.getOrThrow('AWS_S3_REGION'),
      credentials: {
        accessKeyId: this.configService.getOrThrow('AWS_S3_ACCESS_KEY_ID'),
        secretAccessKey: this.configService.getOrThrow('AWS_S3_SECRET_ACCESS_KEY'),
      },
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

  async uploadPrivateFile(file: Express.Multer.File): Promise<IFileUploadFileReturn> {
    const bucketName = this.configService.getOrThrow('AWS_S3_BUCKET');

    // 비공개 저장 + 무작위(UUID) key. 다운로드는 백엔드가 자격증명으로 GetObject 하므로 public-read 불필요.
    // UUID 로 "업로드 시각 + 원본 파일명" 추측 접근을 차단한다. (원본명은 응답/DB 의 originalName 으로 보존)
    const uploadFileName = `private/${this.randomKey()}-${this.sanitizeFileName(file.originalname)}`;

    const fileData: PutObjectCommandInput = {
      Bucket: bucketName,
      Key: uploadFileName,
      Body: file.buffer,
      ACL: 'private',
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

  async downloadFileToLocalWithPath(path: string, fileTitle: string, downloadPath: string): Promise<string> {
    const bucketName = this.configService.getOrThrow('AWS_S3_BUCKET');

    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: downloadPath,
    });

    const { Body } = await this.s3Client.send(command);

    if (Body instanceof Readable) {
      // const filePathList2 = downloadPath.split('/')[filePathList.length - 1].split('-');
      // const filePath = filePathList2.slice(1).join('');
      // 확장자명
      const filePathList = downloadPath.split('.'); //length 를 위한
      const extension = downloadPath.split('.')[filePathList.length - 1];

      const localFilePath = join(path, fileTitle + `.${extension}`);
      const writeStream = fs.createWriteStream(localFilePath);
      Body.pipe(writeStream);

      return new Promise((resolve, reject) => {
        writeStream.on('finish', () => resolve(localFilePath));
        writeStream.on('error', reject);
      });
    }
    throw new Error('Body is not a readable stream');
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
