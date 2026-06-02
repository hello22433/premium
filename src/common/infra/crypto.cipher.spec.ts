import * as crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { CryptoCipher } from './crypto.cipher';

describe('CryptoCipher', () => {
  const SIXTEEN_BYTE_KEY = 'testkey_16bytes!';
  const mockConfigService = {
    getOrThrow: jest.fn().mockReturnValue(SIXTEEN_BYTE_KEY),
  };
  const sut = new CryptoCipher(mockConfigService as any);

  describe('encryptJson', () => {
    test('v2: prefix로 시작하는 토큰을 반환한다', () => {
      const token = sut.encryptJson({ id: 1 });

      expect(token.startsWith('v2:')).toBe(true);
    });

    test('같은 입력에도 매번 다른 토큰을 반환한다 (nonce 랜덤성)', () => {
      const token1 = sut.encryptJson({ id: 1 });
      const token2 = sut.encryptJson({ id: 1 });

      expect(token1).not.toBe(token2);
    });

    test('expiresAt을 전달하면 _exp가 그 시각으로 설정된다', () => {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 1일 후 (만료 안 됨)

      const token = sut.encryptJson({ id: 1 }, expiresAt);
      const result = sut.decryptJson(token) as Record<string, unknown>;

      expect(result._exp).toBe(expiresAt.getTime());
    });

    test('expiresAt 미전달 시 _exp 기본값은 약 5년 후이다', () => {
      const before = sut.decryptJson(sut.encryptJson({ id: 1 })) as Record<string, unknown>;

      const fourYears = Date.now() + 4 * 365 * 24 * 60 * 60 * 1000;
      const sixYears = Date.now() + 6 * 365 * 24 * 60 * 60 * 1000;
      expect(before._exp as number).toBeGreaterThan(fourYears);
      expect(before._exp as number).toBeLessThan(sixYears);
    });

    test('expiresAt이 유효하지 않은 Date면 BadRequestException을 던진다', () => {
      expect(() => sut.encryptJson({ id: 1 }, new Date('invalid'))).toThrow(BadRequestException);
    });
  });

  describe('decryptJson', () => {
    test('encryptJson으로 생성한 토큰을 복호화하면 원본 데이터를 반환한다', () => {
      const original = { id: 42, name: 'test' };
      const token = sut.encryptJson(original);

      const result = sut.decryptJson(token) as Record<string, unknown>;

      expect(result.id).toBe(42);
      expect(result.name).toBe('test');
    });

    test('만료된 토큰을 복호화하면 BadRequestException을 던진다', () => {
      const expiredToken = sut.encryptJson({ id: 1 }, new Date(Date.now() - 1000));

      expect(() => sut.decryptJson(expiredToken)).toThrow(BadRequestException);
    });

    test('authTag가 변조된 v2 토큰을 복호화하면 BadRequestException을 던진다', () => {
      const token = sut.encryptJson({ id: 1 });
      const buf = Buffer.from(token.slice(3), 'base64url');
      buf[12] ^= 0xff; // authTag 첫 바이트 변조 (nonce 12B 이후)
      const tampered = 'v2:' + buf.toString('base64url');

      expect(() => sut.decryptJson(tampered)).toThrow(BadRequestException);
    });

    test('손상된 v2 토큰(복호화 불가)을 복호화하면 BadRequestException을 던진다', () => {
      const garbage = 'v2:' + Buffer.from('not-a-valid-token').toString('base64url');

      expect(() => sut.decryptJson(garbage)).toThrow(BadRequestException);
    });

    test('레거시 ECB 토큰을 복호화하면 원본 데이터를 반환한다', () => {
      const data = { id: 99 };
      const cipher = crypto.createCipheriv('aes-128-ecb', SIXTEEN_BYTE_KEY, null);
      let legacyToken = cipher.update(JSON.stringify(data), 'utf8', 'hex');
      legacyToken += cipher.final('hex');

      const result = sut.decryptJson(legacyToken) as Record<string, unknown>;

      expect(result.id).toBe(99);
    });
  });
});
