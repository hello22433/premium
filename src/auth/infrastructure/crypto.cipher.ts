import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CryptoCipher {
  constructor(private configService: ConfigService) {}

  // JSON 데이터를 암호화하는 함수
  encryptJson(data: object): string {
    // JSON 객체를 문자열로 변환
    const jsonString = JSON.stringify(data);
    const key = this.configService.getOrThrow('CRYPTO_SECRET_KEY');
    const algorithm = this.configService.getOrThrow('CRYPTO_ALGORITHM');

    // 암호화 생성
    const cipher = crypto.createCipheriv(algorithm, key, null);

    // 데이터 암호화
    let encrypted = cipher.update(jsonString, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return encrypted;
  }

  // 암호화된 데이터를 복호화하는 함수
  decryptJson(encryptedData: string): object {
    // 암호화된 JSON 데이터를 파싱
    // const parsedData = JSON.parse(encryptedData);
    const key = this.configService.getOrThrow('CRYPTO_SECRET_KEY');
    const algorithm = this.configService.getOrThrow('CRYPTO_ALGORITHM');

    // const encryptedText = parsedData.data;

    // 복호화 생성
    const decipher = crypto.createDecipheriv(algorithm, key, null);

    // 데이터 복호화
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    // JSON 문자열을 객체로 변환하여 반환
    return JSON.parse(decrypted);
  }
}
