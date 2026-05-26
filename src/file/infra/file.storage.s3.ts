import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IFileStorage, IFileUploadFileReturn } from '../interface/file.storage';
import { GetObjectCommand, PutObjectCommand, PutObjectCommandInput, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { join } from 'path';
import process from 'node:process';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import axios from 'axios';
import { BadRequestException } from '@nestjs/common';

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

  async uploadImageFile(file: Express.Multer.File): Promise<IFileUploadFileReturn> {
    const bucketName = this.configService.getOrThrow('AWS_S3_BUCKET');

    const uploadFileName = `image/${Date.now()}-${this.sanitizeFileName(file.originalname)}`;

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

    const uploadFileName = `file/${Date.now()}-${this.sanitizeFileName(file.originalname)}`;

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

  async downloadFileToLocal(downloadPath: string): Promise<string> {
    const bucketName = this.configService.getOrThrow('AWS_S3_BUCKET');

    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: downloadPath,
    });

    const { Body } = await this.s3Client.send(command);

    if (Body instanceof Readable) {
      const filePathList = downloadPath.split('/');
      const filePathList2 = downloadPath.split('/')[filePathList.length - 1].split('-');
      const filePath = filePathList2.slice(1).join('');

      const localFilePath = join(process.cwd(), '.', 'public', filePath);
      const writeStream = fs.createWriteStream(localFilePath);
      Body.pipe(writeStream);

      return new Promise((resolve, reject) => {
        writeStream.on('finish', () => resolve(localFilePath));
        writeStream.on('error', reject);
      });
    }
    throw new Error('Body is not a readable stream');
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

  private readonly PRIVATE_RANGES = [
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^169\.254\./,
    /^0\./,
    /^::1$/,
    /^fc00:/,
  ];

  async copyImageFromUrl(imageUrl: string): Promise<IFileUploadFileReturn> {
    const bucketName = this.configService.getOrThrow('AWS_S3_BUCKET');

    const parsedUrl = new URL(imageUrl);
    const { address } = await dns.lookup(parsedUrl.hostname);

    if (this.PRIVATE_RANGES.some((p) => p.test(address))) {
      throw new BadRequestException('허용되지 않는 URL입니다.');
    }

    const requestUrl = imageUrl.replace(parsedUrl.hostname, address);
    const response = await axios.get(requestUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxRedirects: 0,
      headers: { Host: parsedUrl.hostname },
    });

    const buffer = Buffer.from(response.data);

    const urlPath = parsedUrl.pathname;
    const originalName = decodeURIComponent(urlPath.split('/').pop() || 'image.jpg');

    // S3 업로드 경로 생성
    const uploadFileName = `image/${Date.now()}-${this.sanitizeFileName(originalName)}`;

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
