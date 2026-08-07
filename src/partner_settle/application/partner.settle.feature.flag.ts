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
 * - `PARTNER_SETTLE_REVIEW_RESOLUTION_ENABLED` — NEEDS_REVIEW 해소 API 별도 kill switch.
 * - `PARTNER_SETTLE_CONFIRM_ENABLED` — 정산확정/해제/hold-release API kill switch (PR1D).
 * - `PARTNER_SETTLE_PAID_ENABLED` — 지급(paid) API kill switch (PR1D, PR3 variance 검증 후 활성화).
 *
 * 원장 producer와 검토 해소 API는 독립적으로 배포한다. 해소 API는 명시적으로 true인 경우에만
 * 노출되며, 미설정·오타·producer flag 활성화만으로는 켜지지 않는다.
 */
@Injectable()
export class PartnerSettleFeatureFlag {
  constructor(private readonly configService: ConfigService) {}

  /** 전역 kill switch. 이것이 off 면 provider CSV 와 무관하게 전부 no-op 이다. */
  get isEnabled(): boolean {
    return this.configService.get('PARTNER_SETTLE_LEDGER_ENABLED') === 'true';
  }

  /** NEEDS_REVIEW 해소 API의 별도 kill switch. 미설정은 fail-closed다. */
  get isReviewResolutionEnabled(): boolean {
    return this.configService.get('PARTNER_SETTLE_REVIEW_RESOLUTION_ENABLED') === 'true';
  }

  /** 정산확정(confirm/unconfirm/release/hold-release/batches) API kill switch. 미설정은 fail-closed. */
  get isConfirmEnabled(): boolean {
    return this.configService.get('PARTNER_SETTLE_CONFIRM_ENABLED') === 'true';
  }

  /** 지급(paid) API kill switch. PR3 variance 검증 후 활성화. 미설정은 fail-closed. */
  get isPaidEnabled(): boolean {
    return this.configService.get('PARTNER_SETTLE_PAID_ENABLED') === 'true';
  }

  /**
   * 정산조건 예약 발효 cron kill switch (PR3B). 미설정은 fail-closed.
   *
   * **PR3C(소급 재계산·차액 proposal) 배포 전에는 미래 예약이라도 켜지 않는다.** cron 은 정상
   * 동작에서도 `effectiveAt` 뒤에 돌기 때문에, 그 사이 생성된 원장은 이미 옛 조건으로 확정돼 있고
   * 재계산 경로 없이는 조건 변경이 원장에 반영되지 않는다.
   */
  get isDiscountReservationCronEnabled(): boolean {
    return this.configService.get('PARTNER_DISCOUNT_RESERVATION_CRON_ENABLED') === 'true';
  }

  /**
   * 소급 예약(생성 시점에 `effectiveAt` 이 이미 과거) 개방 여부 (PR3B). 미설정은 fail-closed.
   *
   * 생성·발효 양쪽에서 검사한다. 생성만 막으면 flag 를 껐다 켠 사이에 만들어진 PENDING 이나 운영 DB
   * 직접 삽입분이 그대로 발효된다.
   */
  get isDiscountRetroactiveEnabled(): boolean {
    return this.configService.get('PARTNER_DISCOUNT_RETROACTIVE_ENABLED') === 'true';
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
