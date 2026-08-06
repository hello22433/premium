import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';

/**
 * 원장 producer feature flag (PR1B 명세 §4.6).
 *
 * 배포 기본값은 **전부 off** 다. off 면 producer 는 DB 를 건드리지 않고 즉시 빠져나가며, 기존
 * 배치·push·CS 동작이 1비트도 바뀌지 않아야 한다(§4.6 회귀 요건).
 *
 * - `PARTNER_SETTLE_LEDGER_ENABLED` — 전역 kill switch
 * - `PARTNER_SETTLE_LEDGER_PROVIDERS` — 활성 provider CSV. 단계 활성화용이며
 *   **비어 있으면 아무 provider 도 켜지지 않는다**(빈 값을 "전체 허용" 으로 읽으면 kill switch 를 켜는
 *   순간 6개 provider 가 한꺼번에 원장을 쓰기 시작한다).
 *
 * on 전환은 정본 §15.2 배포 순서(cutover 장벽 → seed → backfill → 게이트)의 소관이고,
 * §0.1 활성 협력사 정산조건 확인 전에는 켜지 않는다.
 */
@Injectable()
export class PartnerSettleFeatureFlag {
  constructor(private readonly configService: ConfigService) {}

  /** 전역 kill switch. 이것이 off 면 provider CSV 와 무관하게 전부 no-op 이다. */
  get isEnabled(): boolean {
    return this.configService.get('PARTNER_SETTLE_LEDGER_ENABLED') === 'true';
  }

  isEnabledFor(provider: IPartnerCompanyType | null | undefined): boolean {
    if (!provider || !this.isEnabled) return false;
    return this.activeProviders().includes(provider);
  }

  private activeProviders(): string[] {
    const raw = this.configService.get<string>('PARTNER_SETTLE_LEDGER_PROVIDERS') ?? '';
    return raw
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter((value) => value.length > 0);
  }
}
