import { Test, TestingModule } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';
import { WalletCutoverBundleBootstrap } from './wallet-cutover-bundle.bootstrap';
import { WalletCutoverConfig, WalletCutoverMode } from '../config/wallet-cutover.config';

async function buildSut(
  pr2Mode: WalletCutoverMode,
  diLookup: Record<string, unknown | null>,
): Promise<WalletCutoverBundleBootstrap> {
  const config = { pr2DeliveryLifecycleMode: pr2Mode } as unknown as WalletCutoverConfig;
  const moduleRef = {
    get: jest.fn((name: string) => {
      if (Object.prototype.hasOwnProperty.call(diLookup, name)) {
        const v = diLookup[name];
        if (v == null) {
          throw new Error(`Nest could not find ${name}`);
        }
        return v;
      }
      throw new Error(`Nest could not find ${name}`);
    }),
  } as unknown as ModuleRef;

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      WalletCutoverBundleBootstrap,
      { provide: WalletCutoverConfig, useValue: config },
      { provide: ModuleRef, useValue: moduleRef },
    ],
  }).compile();
  return module.get(WalletCutoverBundleBootstrap);
}

describe('WalletCutoverBundleBootstrap', () => {
  const fullDi: Record<string, unknown> = {
    SettleConfirmationWalletService: {},
    RefundPoolService: {},
    ResendDeductService: {},
  };

  it('PR2 mode != WALLET → no-op (legacy/shadow 모두)', async () => {
    for (const mode of [WalletCutoverMode.LEGACY, WalletCutoverMode.SHADOW]) {
      const sut = await buildSut(mode, {});
      await expect(sut.onApplicationBootstrap()).resolves.toBeUndefined();
    }
  });

  it('PR2 mode = WALLET + PR3+PR4 service 모두 DI → 통과', async () => {
    const sut = await buildSut(WalletCutoverMode.WALLET, fullDi);
    await expect(sut.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('PR2 mode = WALLET + SettleConfirmationWalletService 누락 → throw', async () => {
    const sut = await buildSut(WalletCutoverMode.WALLET, {
      RefundPoolService: {},
      ResendDeductService: {},
    });
    await expect(sut.onApplicationBootstrap()).rejects.toThrow(/SettleConfirmationWalletService/);
    await expect(sut.onApplicationBootstrap()).rejects.toThrow(/wallet_cutover_activation_gate_blocked/);
  });

  it('PR2 mode = WALLET + RefundPoolService 누락 → throw', async () => {
    const sut = await buildSut(WalletCutoverMode.WALLET, {
      SettleConfirmationWalletService: {},
      ResendDeductService: {},
    });
    await expect(sut.onApplicationBootstrap()).rejects.toThrow(/RefundPoolService/);
  });

  it('PR2 mode = WALLET + ResendDeductService 누락 → throw', async () => {
    const sut = await buildSut(WalletCutoverMode.WALLET, {
      SettleConfirmationWalletService: {},
      RefundPoolService: {},
    });
    await expect(sut.onApplicationBootstrap()).rejects.toThrow(/ResendDeductService/);
  });

  it('PR2 mode = WALLET + 3 service 모두 누락 → throw with 3건 메시지', async () => {
    const sut = await buildSut(WalletCutoverMode.WALLET, {});
    await expect(sut.onApplicationBootstrap()).rejects.toThrow(
      /SettleConfirmationWalletService.*RefundPoolService.*ResendDeductService/,
    );
  });

  it('error 메시지에 fail-closed + 자동 fallback 금지 명시', async () => {
    const sut = await buildSut(WalletCutoverMode.WALLET, {});
    await expect(sut.onApplicationBootstrap()).rejects.toThrow(/Principle 2 fail-closed/);
    await expect(sut.onApplicationBootstrap()).rejects.toThrow(/RUNBOOK section 12/);
  });
});
