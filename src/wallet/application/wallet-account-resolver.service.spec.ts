import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { UserEntity } from '../../entity/user.entity';
import { WalletAccountResolverService } from './wallet-account-resolver.service';

describe('WalletAccountResolverService', () => {
  let sut: WalletAccountResolverService;
  let walletRepo: jest.Mocked<Repository<WalletAccountEntity>>;
  let userRepo: jest.Mocked<Repository<UserEntity>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletAccountResolverService,
        { provide: DataSource, useValue: { manager: {} } },
        { provide: getRepositoryToken(WalletAccountEntity), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(UserEntity), useValue: { findOne: jest.fn() } },
      ],
    }).compile();
    sut = module.get(WalletAccountResolverService);
    walletRepo = module.get(getRepositoryToken(WalletAccountEntity));
    userRepo = module.get(getRepositoryToken(UserEntity));
  });

  it('settlement_code 로 wallet_account 단일 조회', async () => {
    const wallet = { id: '1', ownerType: 'SETTLEMENT_CODE', ownerId: 'company-7' } as WalletAccountEntity;
    walletRepo.findOne.mockResolvedValue(wallet);
    await expect(sut.resolveBySettlementCode('company-7')).resolves.toBe(wallet);
    expect(walletRepo.findOne).toHaveBeenCalledWith({
      where: { ownerType: 'SETTLEMENT_CODE', ownerId: 'company-7' },
    });
  });

  it('미존재 settlement_code → NotFoundException', async () => {
    walletRepo.findOne.mockResolvedValue(null);
    await expect(sut.resolveBySettlementCode('company-999')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('같은 회사 user 들이 같은 wallet 조회 (consensus plan integration test)', async () => {
    const sharedWallet = { id: '5', ownerId: 'company-3' } as WalletAccountEntity;
    userRepo.findOne.mockImplementation(
      async ({ where }: any) =>
        ({
          id: where.id,
          settlementCode: 'company-3',
        }) as UserEntity,
    );
    walletRepo.findOne.mockResolvedValue(sharedWallet);

    const a = await sut.resolveByUserId(1);
    const b = await sut.resolveByUserId(2);
    expect(a.id).toBe(b.id);
  });

  it('user 미존재 → NotFoundException', async () => {
    userRepo.findOne.mockResolvedValue(null);
    await expect(sut.resolveByUserId(404)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('user.settlement_code 비어있으면 NotFoundException (backfill 누락 케이스)', async () => {
    userRepo.findOne.mockResolvedValue({ id: 1, settlementCode: '' } as UserEntity);
    await expect(sut.resolveByUserId(1)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resolveForOrder: clientUserId 있으면 그 user 의 wallet (대행주문 호환)', async () => {
    userRepo.findOne.mockImplementation(
      async ({ where }: any) =>
        ({
          id: where.id,
          settlementCode: `company-${where.id}`,
        }) as UserEntity,
    );
    walletRepo.findOne.mockImplementation(
      async ({ where }: any) =>
        ({
          id: 'w-' + where.ownerId,
          ownerId: where.ownerId,
        }) as WalletAccountEntity,
    );

    const wallet = await sut.resolveForOrder({ userId: 1, clientUserId: 99 });
    expect(wallet.id).toBe('w-company-99');
  });

  it('resolveForOrder: clientUserId null 이면 userId 의 wallet (일반 주문)', async () => {
    userRepo.findOne.mockImplementation(
      async ({ where }: any) =>
        ({
          id: where.id,
          settlementCode: `company-${where.id}`,
        }) as UserEntity,
    );
    walletRepo.findOne.mockImplementation(
      async ({ where }: any) =>
        ({
          id: 'w-' + where.ownerId,
          ownerId: where.ownerId,
        }) as WalletAccountEntity,
    );

    const wallet = await sut.resolveForOrder({ userId: 7, clientUserId: null });
    expect(wallet.id).toBe('w-company-7');
  });
});
