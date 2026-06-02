import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, Injectable } from '@nestjs/common';

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

  // gsmbiz 암호화
  gsmEncrypt(data: string, key: string, iv: string, algorithm: string): string {
    const keyBuffer = Buffer.from(key, 'utf8');
    const ivBuffer = Buffer.from(iv, 'utf8');

    const cipher = crypto.createCipheriv(algorithm, keyBuffer, ivBuffer);
    let encrypted = cipher.update(data, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return encrypted;
  }

  // gsmbiz 복호화
  gsmDecrypt(data: string, key: string, iv: string, algorithm: string): string {
    const keyBuffer = Buffer.from(key, 'utf8');
    const ivBuffer = Buffer.from(iv, 'utf8');

    const decipher = crypto.createDecipheriv(algorithm, keyBuffer, ivBuffer);
    let decrypted = decipher.update(data, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // JSON 데이터를 암호화하는 함수 (AES-128-GCM, v2 토큰)
  encryptJson(data: object): string {
    const key = this.configService.getOrThrow('CRYPTO_SECRET_KEY');
    const exp = Date.now() + 181 * 24 * 60 * 60 * 1000;
    const jsonString = JSON.stringify({ ...data, _exp: exp });

    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-128-gcm', key, nonce);
    const encrypted = Buffer.concat([cipher.update(jsonString, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return 'v2:' + Buffer.concat([nonce, authTag, encrypted]).toString('base64url');
  }

  // 암호화된 데이터를 복호화하는 함수
  decryptJson(encryptedData: string): object {
    if (encryptedData.startsWith('v2:')) {
      const key = this.configService.getOrThrow('CRYPTO_SECRET_KEY');
      const buf = Buffer.from(encryptedData.slice(3), 'base64url');

      const nonce = buf.subarray(0, 12);
      const authTag = buf.subarray(12, 28);
      const ciphertext = buf.subarray(28);

      const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      const parsed = JSON.parse(decrypted.toString('utf8')) as Record<string, unknown>;
      if (typeof parsed._exp === 'number' && Date.now() > parsed._exp) {
        throw new BadRequestException('만료된 링크입니다.');
      }
      return parsed;
    }

    // 레거시 AES-128-ECB 토큰 호환
    const key = this.configService.getOrThrow('CRYPTO_SECRET_KEY');
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  }

  // deliveryTarget 암호화 (AES-256-CBC, Base64)
  encryptDeliveryTarget(data: string): string {
    const key = this.configService.getOrThrow('DELIVERY_TARGET_CRYPTO_KEY');
    const iv = this.configService.getOrThrow('DELIVERY_TARGET_CRYPTO_IV');
    const algorithm = 'aes-256-cbc';

    const keyBuffer = Buffer.from(key, 'utf8');
    const ivBuffer = Buffer.from(iv, 'utf8');

    const cipher = crypto.createCipheriv(algorithm, keyBuffer, ivBuffer);
    let encrypted = cipher.update(data, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    return encrypted;
  }

  // deliveryTarget 복호화 (AES-256-CBC, Base64)
  decryptDeliveryTarget(encryptedData: string): string {
    const key = this.configService.getOrThrow('DELIVERY_TARGET_CRYPTO_KEY');
    const iv = this.configService.getOrThrow('DELIVERY_TARGET_CRYPTO_IV');
    const algorithm = 'aes-256-cbc';

    const keyBuffer = Buffer.from(key, 'utf8');
    const ivBuffer = Buffer.from(iv, 'utf8');

    const decipher = crypto.createDecipheriv(algorithm, keyBuffer, ivBuffer);
    let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * deliveryTarget 안전 복호화 — 실패 시 원본 반환
   */
  safeDecryptDeliveryTarget(encryptedData: string | null | undefined): string | null {
    if (!encryptedData) return null;
    try {
      return this.decryptDeliveryTarget(encryptedData);
    } catch {
      return encryptedData;
    }
  }
}
