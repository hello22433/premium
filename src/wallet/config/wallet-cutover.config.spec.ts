import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WalletCutoverConfig, WalletCutoverMode, WALLET_CUTOVER_ENV_KEYS } from './wallet-cutover.config';

async function buildSut(env: Record<string, string | undefined>): Promise<WalletCutoverConfig> {
  const config: Pick<ConfigService, 'get'> = {
    get: jest.fn((key: string) => env[key]) as unknown as ConfigService['get'],
  };
  const module: TestingModule = await Test.createTestingModule({
    providers: [WalletCutoverConfig, { provide: ConfigService, useValue: config }],
  }).compile();
  return module.get(WalletCutoverConfig);
}

describe('WalletCutoverConfig', () => {
  it('미설정 → LEGACY default (3 mode 모두)', async () => {
    const sut = await buildSut({});
    expect(sut.pr2DeliveryLifecycleMode).toBe(WalletCutoverMode.LEGACY);
    expect(sut.pr3SettleMode).toBe(WalletCutoverMode.LEGACY);
    expect(sut.pr4CsResendMode).toBe(WalletCutoverMode.LEGACY);
  });

  it('shadow → SHADOW', async () => {
    const sut = await buildSut({
      [WALLET_CUTOVER_ENV_KEYS.pr2DeliveryLifecycle]: 'shadow',
    });
    expect(sut.pr2DeliveryLifecycleMode).toBe(WalletCutoverMode.SHADOW);
  });

  it('wallet → WALLET', async () => {
    const sut = await buildSut({
      [WALLET_CUTOVER_ENV_KEYS.pr3Settle]: 'wallet',
    });
    expect(sut.pr3SettleMode).toBe(WalletCutoverMode.WALLET);
  });

  it('대소문자 무시 + trim', async () => {
    const sut = await buildSut({
      [WALLET_CUTOVER_ENV_KEYS.pr4CsResend]: '  WALLET  ',
    });
    expect(sut.pr4CsResendMode).toBe(WalletCutoverMode.WALLET);
  });

  it('빈 문자열 → LEGACY default', async () => {
    const sut = await buildSut({
      [WALLET_CUTOVER_ENV_KEYS.pr2DeliveryLifecycle]: '',
    });
    expect(sut.pr2DeliveryLifecycleMode).toBe(WalletCutoverMode.LEGACY);
  });

  it('잘못된 값 → throw (fail-closed)', async () => {
    const sut = await buildSut({
      [WALLET_CUTOVER_ENV_KEYS.pr2DeliveryLifecycle]: 'auto',
    });
    expect(() => sut.pr2DeliveryLifecycleMode).toThrow(/Invalid WALLET_PR2_DELIVERY_LIFECYCLE_MODE/);
  });

  it('잘못된 값에 fallback 코드 없음 (grep guard)', async () => {
    const sut = await buildSut({
      [WALLET_CUTOVER_ENV_KEYS.pr2DeliveryLifecycle]: 'unknown',
    });
    // throw 만 발생, 자동 LEGACY fallback 금지
    expect(() => sut.pr2DeliveryLifecycleMode).toThrow();
  });
});
