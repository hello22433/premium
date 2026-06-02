import * as crypto from 'crypto';
import { addYears } from 'date-fns';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CryptoCipher {
  constructor(private configService: ConfigService) {}

  // JSON 데이터를 암호화하는 함수 (AES-128-GCM, v2 토큰)
  encryptJson(data: object, expiresAt?: Date): string {
    const key = this.configService.getOrThrow('CRYPTO_SECRET_KEY');
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw new BadRequestException('올바른 만료일이 아닙니다.');
    }
    // 만료: expiresAt 있으면 그 시각, 없으면 5년 폴백(윤년 안전). 호출부가 쿠폰 유효기간+1일을 전달.
    const exp = expiresAt ? expiresAt.getTime() : addYears(new Date(), 5).getTime();
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

      let parsed: Record<string, unknown>;
      try {
        const buf = Buffer.from(encryptedData.slice(3), 'base64url');

        const nonce = buf.subarray(0, 12);
        const authTag = buf.subarray(12, 28);
        const ciphertext = buf.subarray(28);

        const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

        parsed = JSON.parse(decrypted.toString('utf8')) as Record<string, unknown>;
      } catch {
        throw new BadRequestException('올바르지 않은 링크입니다.');
      }

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
}
