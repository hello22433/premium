import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_PREFIX = 'v1:';

/**
 * 재고형 PIN 전용 AES-256-GCM 암호화 서비스. rev5 §5.
 *
 * - 고정 IV 없음, random 96-bit nonce
 * - AAD: schemaVersion|cryptoContextId|productId|codeSchemaVersion|fieldRole
 * - HMAC fingerprint용 별도 고정 키
 * - 기동 시 active key 검증 (누락 → 기동 실패)
 */
@Injectable()
export class InventoryPinCryptoService implements OnModuleInit {
  private activeKeyVersion: string;
  private keyRing: Map<string, Buffer> = new Map();
  private hmacKey: Buffer;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.activeKeyVersion = this.configService.getOrThrow('PIN_INVENTORY_CRYPTO_ACTIVE_KEY_VERSION');
    const keysJson = this.configService.getOrThrow('PIN_INVENTORY_CRYPTO_KEY_RING');
    const keys: Record<string, string> = JSON.parse(keysJson);
    for (const [version, hexKey] of Object.entries(keys)) {
      if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
        throw new Error(`PIN_INVENTORY: key "${version}" is not valid 32-byte hex (got ${hexKey.length} chars)`);
      }
      const buf = Buffer.from(hexKey, 'hex');
      // all-zero 키 거부 (실수로 .env.example 값 사용 방지)
      if (buf.every(b => b === 0)) {
        throw new Error(`PIN_INVENTORY: key "${version}" is all-zero — do not use .env.example placeholder as a real key`);
      }
      this.keyRing.set(version, buf);
    }
    if (!this.keyRing.has(this.activeKeyVersion)) {
      throw new Error(`PIN_INVENTORY: active key version "${this.activeKeyVersion}" not in key ring`);
    }
    const hmacKeyHex = this.configService.getOrThrow('PIN_INVENTORY_HMAC_KEY');
    if (!/^[0-9a-fA-F]{64}$/.test(hmacKeyHex)) {
      throw new Error(`PIN_INVENTORY: HMAC key is not valid 32-byte hex (got ${hmacKeyHex.length} chars)`);
    }
    this.hmacKey = Buffer.from(hmacKeyHex, 'hex');
    if (this.hmacKey.every(b => b === 0)) {
      throw new Error('PIN_INVENTORY: HMAC key is all-zero — do not use .env.example placeholder as a real key');
    }
  }

  getActiveKeyVersion(): string {
    return this.activeKeyVersion;
  }

  /**
   * 암호화: random nonce + AES-256-GCM + AAD.
   * 반환: v1:<base64url(nonce|authTag|ciphertext)>
   */
  encrypt(
    plaintext: string,
    aad: EncryptionAAD,
  ): string {
    const key = this.keyRing.get(this.activeKeyVersion)!;
    const nonce = randomBytes(NONCE_BYTES);
    const aadBuffer = this.buildAAD(aad);
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aadBuffer);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const combined = Buffer.concat([nonce, tag, ciphertext]);
    return ENVELOPE_PREFIX + combined.toString('base64url');
  }

  /**
   * 복호화: envelope prefix → nonce|tag|ciphertext 분해 → AES-256-GCM + AAD.
   * 실패 → fail closed (원문/암호문 폴백 금지).
   */
  decrypt(
    envelope: string,
    keyVersion: string,
    aad: EncryptionAAD,
  ): string {
    if (!envelope.startsWith(ENVELOPE_PREFIX)) {
      throw new Error('PIN_INVENTORY_CRYPTO: invalid envelope prefix');
    }
    const key = this.keyRing.get(keyVersion);
    if (!key) {
      throw new Error(`PIN_INVENTORY_CRYPTO: key version "${keyVersion}" not in ring`);
    }
    const combined = Buffer.from(envelope.slice(ENVELOPE_PREFIX.length), 'base64url');
    if (combined.length < NONCE_BYTES + TAG_BYTES + 1) {
      throw new Error('PIN_INVENTORY_CRYPTO: envelope too short');
    }
    const nonce = combined.subarray(0, NONCE_BYTES);
    const tag = combined.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const ciphertext = combined.subarray(NONCE_BYTES + TAG_BYTES);
    const aadBuffer = this.buildAAD(aad);
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadBuffer);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf-8');
  }

  /**
   * primary code HMAC-SHA-256 fingerprint.
   * 입력: productId + NUL + primaryCode
   */
  primaryFingerprint(productId: number, primaryCode: string): Buffer {
    const input = `${productId}\0${primaryCode}`;
    return createHmac('sha256', this.hmacKey).update(input, 'utf-8').digest();
  }

  /**
   * primary+secondary pair HMAC fingerprint.
   * 입력: productId + NUL + primaryCode + NUL + secondaryCode
   */
  pairFingerprint(productId: number, primaryCode: string, secondaryCode: string | null): Buffer {
    const parts = secondaryCode != null
      ? `${productId}\0${primaryCode}\0${secondaryCode}`
      : `${productId}\0${primaryCode}\0`;
    return createHmac('sha256', this.hmacKey).update(parts, 'utf-8').digest();
  }

  /**
   * PIN 마스킹: 충분히 긴 코드는 끝 4자만 표시, 짧은 코드는 전체 마스킹.
   */
  mask(code: string): string {
    if (code.length <= 4) {
      return '*'.repeat(code.length);
    }
    return '*'.repeat(code.length - 4) + code.slice(-4);
  }

  private buildAAD(aad: EncryptionAAD): Buffer {
    const str = `1|${aad.cryptoContextId}|${aad.productId}|${aad.codeSchemaVersion}|${aad.fieldRole}`;
    return Buffer.from(str, 'utf-8');
  }
}

export interface EncryptionAAD {
  cryptoContextId: string;
  productId: number;
  codeSchemaVersion: number;
  fieldRole: 'PRIMARY' | 'SECONDARY';
}
