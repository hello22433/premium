import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Wallet Cutover Bundle (plan v2.1) flag mode.
 *
 * 3-mode 의 의미:
 *   - LEGACY: legacy path 만 동작. wallet write 0건. 배포 직후 prod 기본값.
 *   - SHADOW: deliveryConfirmed 시점 wallet 결과를 동기 preview 계산 후 legacy 와 비교 로그.
 *             wallet write 없음. 후속 hook (refundForFail/settle/CS) 은 비교 안 함 (persisted state 부재).
 *   - WALLET: wallet primary + legacy mirror same-tx. fail-closed. allocation 생성.
 *
 * Routing 우선순위 (Round 5 결정): allocation 존재 + released_at IS NULL → 후속 hook 무조건 wallet path.
 * 즉 flag mode 는 *신규 주문* 의 path 결정 + shadow 비교 활성화만 담당.
 */
export enum WalletCutoverMode {
  LEGACY = 'legacy',
  SHADOW = 'shadow',
  WALLET = 'wallet',
}

const ALL_MODES = Object.values(WalletCutoverMode) as ReadonlyArray<WalletCutoverMode>;

export const WALLET_CUTOVER_ENV_KEYS = {
  pr2DeliveryLifecycle: 'WALLET_PR2_DELIVERY_LIFECYCLE_MODE',
  pr3Settle: 'WALLET_PR3_SETTLE_MODE',
  pr4CsResend: 'WALLET_PR4_CS_RESEND_MODE',
} as const;

@Injectable()
export class WalletCutoverConfig {
  constructor(private readonly config: ConfigService) {}

  get pr2DeliveryLifecycleMode(): WalletCutoverMode {
    return this.resolve(WALLET_CUTOVER_ENV_KEYS.pr2DeliveryLifecycle);
  }

  get pr3SettleMode(): WalletCutoverMode {
    return this.resolve(WALLET_CUTOVER_ENV_KEYS.pr3Settle);
  }

  get pr4CsResendMode(): WalletCutoverMode {
    return this.resolve(WALLET_CUTOVER_ENV_KEYS.pr4CsResend);
  }

  /**
   * settlement_code 가드(발송요청) 활성화 여부. 기본 OFF (DARK).
   * cutover 플래그와 동일하게 ConfigService.get 으로 ENV 를 읽는다.
   */
  get settlementCodeGuardEnforced(): boolean {
    const raw = this.config.get<string>(SETTLEMENT_CODE_GUARD_ENV_KEY);
    if (raw == null) {
      return false;
    }
    const normalized = raw.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'on';
  }

  /**
   * ENV 값 → enum. 미설정 시 LEGACY. 잘못된 값은 fail-closed throw (boot 시점).
   */
  private resolve(envKey: string): WalletCutoverMode {
    const raw = this.config.get<string>(envKey);
    if (raw == null || raw === '') {
      return WalletCutoverMode.LEGACY;
    }
    const normalized = raw.trim().toLowerCase();
    if ((ALL_MODES as ReadonlyArray<string>).includes(normalized)) {
      return normalized as WalletCutoverMode;
    }
    throw new Error(
      `Invalid ${envKey} = '${raw}'. Must be one of ${ALL_MODES.join('|')} (fail-closed: legacy fallback 금지).`,
    );
  }
}

/**
 * settlement_code 가드(발송요청) 활성화 플래그.
 * 'true' | '1' | 'on' (대소문자 무시) 만 활성. 미설정/그 외 값은 비활성(기본 OFF).
 */
export const SETTLEMENT_CODE_GUARD_ENV_KEY = 'SETTLEMENT_CODE_GUARD_ENFORCE';
