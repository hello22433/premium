import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { WalletCutoverConfig, WalletCutoverMode } from '../config/wallet-cutover.config';

/**
 * Wallet Cutover Bundle 의 startup gate (plan v2.1 F-006 + Cross-PR Concerns).
 *
 * 목적:
 *   PR2 mode = WALLET 로 활성화하려면 PR3/PR4 hook 코드도 prod 에 배포되어 있어야 한다
 *   (allocation routing > flag 라 후속 hook 이 wallet path 진입할 수 있기 때문). 누락 시
 *   wallet-managed 주문이 발생하면 정산/CS/재발송이 throw → 발송/정산 중단.
 *
 * 동작:
 *   - PR2 mode != WALLET → no-op.
 *   - PR2 mode == WALLET:
 *     1) PR3 SettleConfirmationWalletService (또는 PR3 hook 의 핵심 service)
 *     2) PR4 RefundPoolService DISCARD_REFUND handler 의 핵심 service
 *     3) PR4 ResendDeductService
 *     중 1개라도 DI 미충족 → throw → NestJS bootstrap 중단 → `main.ts` 가 process.exit(1).
 *
 * 금지 (fail-closed, plan Principle 2):
 *   - WALLET → LEGACY 자동 fallback. catch + flag downgrade 절대 도입 안 함.
 *   - 누락 service 만 우회하고 부분 wallet 동작. 모두 갖춰지지 않으면 부팅 중단.
 *
 * 운영 복구:
 *   - PagerDuty (`WALLET_CUTOVER_PD_SERVICE_KEY`, severity=critical) 알림.
 *   - 운영자가 ENV `WALLET_PR2_DELIVERY_LIFECYCLE_MODE=legacy` 로 즉시 복귀 + service restart.
 *   - 근본 원인 (CI 누락 / DI 등록 누락) 해결 후 재진입.
 *
 * @see plan v2.1 RUNBOOK section 12 (Manual recovery)
 * @see spec Constraint §4 (legacy fallback 금지)
 */
@Injectable()
export class WalletCutoverBundleBootstrap implements OnApplicationBootstrap {
  private static readonly REQUIRED_PR3_PR4_SERVICES = [
    'SettleConfirmationWalletService',
    'RefundPoolService',
    'ResendDeductService',
  ] as const;

  private readonly logger = new Logger(WalletCutoverBundleBootstrap.name);

  constructor(
    private readonly config: WalletCutoverConfig,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const pr2Mode = this.config.pr2DeliveryLifecycleMode;
    if (pr2Mode !== WalletCutoverMode.WALLET) {
      this.logger.log(`Wallet Cutover Bundle activation gate: PR2 mode=${pr2Mode}, gate skipped.`);
      return;
    }

    const missing = this.detectMissingDownstreamServices();
    if (missing.length === 0) {
      this.logger.log('Wallet Cutover Bundle activation gate: PR2 mode=WALLET, PR3+PR4 hook services present.');
      return;
    }

    // fail-closed: throw 만 발생. auto-fallback 코드 미존재.
    const message =
      `wallet_cutover_activation_gate_blocked: PR2 mode=WALLET but downstream hook services missing: [${missing.join(', ')}]. ` +
      `Bootstrap aborted (process exit 1). See RUNBOOK section 12 (Manual recovery). ` +
      `auto legacy fallback 절대 도입 안 함 (Principle 2 fail-closed).`;
    this.logger.error(message);
    throw new Error(message);
  }

  /**
   * NestJS DI 컨테이너에서 downstream service 존재 검증.
   * ModuleRef 미주입 환경(test 등)에서는 항상 빈 배열 반환 — 별도 spec 으로 검증.
   */
  private detectMissingDownstreamServices(): string[] {
    if (!this.moduleRef) {
      return [];
    }
    const missing: string[] = [];
    for (const name of WalletCutoverBundleBootstrap.REQUIRED_PR3_PR4_SERVICES) {
      try {
        const found = this.moduleRef.get(name, { strict: false });
        if (!found) {
          missing.push(name);
        }
      } catch {
        missing.push(name);
      }
    }
    return missing;
  }
}
