import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';

@Injectable()
export class CryptoCipher {
  constructor(private configService: ConfigService) {}

  encrypt(data: string, key: string, iv: string, algorithm: string): string {
    // const algorithm = 'aes-128-cbc'; // Java 코드에서 "AES/CBC/PKCS5PADDING" 사용
    const keyBuffer = Buffer.from(key, 'base64'); // Base64 디코딩
    const ivBuffer = Buffer.from(iv, 'utf8'); // IV는 UTF-8로 처리

    // 암호화 생성
    const cipher = crypto.createCipheriv(algorithm, keyBuffer, ivBuffer);

    // 데이터 암호화
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return encrypted; // 암호화된 데이터 반환
  }

  // 암호화된 데이터를 복호화하는 함수
  decrypt(data: string, key: string, iv: string, algorithm: string): string {
    // const algorithm = 'aes-128-cbc';
    const keyBuffer = Buffer.from(key, 'base64');
    const ivBuffer = Buffer.from(iv, 'utf8');

    // 복호화 생성
    const decipher = crypto.createDecipheriv(algorithm, keyBuffer, ivBuffer);

    // 데이터 복호화 (Hex -> UTF-8)
    let decrypted = decipher.update(data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted; // 복호화된 데이터 반환
  }
}
