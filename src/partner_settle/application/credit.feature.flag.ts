import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * 여신 API(credit/list · credit/config) 활성화 플래그 (정본 §15.2).
 *
 * 여신 API 는 **배포 시 off** 다. on 전환은 정본 §15.2 배포 순서(마이그레이션 → config seed →
 * `SETTLE_CREDIT` 권한 배포 → flag on)의 소관이며 코드 merge 와 분리된다.
 *
 * `'true' | '1' | 'on'`(대소문자 무시)만 활성. 미설정/그 외 값은 비활성(기본 OFF · fail-closed).
 * cutover 플래그와 동일하게 `ConfigService.get` 으로 ENV 를 읽는다(`wallet-cutover.config.ts` 관례).
 */
export const CREDIT_API_ENV_KEY = 'SETTLE_CREDIT_API_ENABLED';

@Injectable()
export class CreditFeatureFlag {
  constructor(private readonly config: ConfigService) {}

  get creditApiEnabled(): boolean {
    const raw = this.config.get<string>(CREDIT_API_ENV_KEY);
    if (raw == null) return false;
    const normalized = raw.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'on';
  }
}
