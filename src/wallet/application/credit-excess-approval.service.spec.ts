import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CreditExcessApprovalEntity, CreditExcessApprovalStatus } from '../../entity/credit.excess.approval.entity';
import { CreditExcessApprovalService } from './credit-excess-approval.service';
import { WalletAccountResolverService } from './wallet-account-resolver.service';

describe('CreditExcessApprovalService — 4단계 워크플로', () => {
  let sut: CreditExcessApprovalService;
  let repo: any;
  let orderRepo: any;
  let walletAccountResolver: any;

  beforeEach(async () => {
    repo = {
      save: jest.fn(async (obj: any) => ({ id: 'app1', ...obj })),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      }),
    };
    // Default: order owned by user 7 (matches requestedBy), wallet id matches '1'.
    orderRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 1, userId: 7, clientUserId: null }),
    };
    walletAccountResolver = {
      resolveForOrder: jest.fn().mockResolvedValue({ id: '1' }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreditExcessApprovalService,
        { provide: getRepositoryToken(CreditExcessApprovalEntity), useValue: repo },
        {
          provide: getDataSourceToken(),
          useValue: { getRepository: jest.fn(() => orderRepo) },
        },
        { provide: WalletAccountResolverService, useValue: walletAccountResolver },
      ],
    }).compile();
    sut = module.get(CreditExcessApprovalService);
  });

  it('Step B request — reasonText 누락 시 BadRequest', async () => {
    await expect(
      sut.request({
        orderId: 1,
        walletAccountId: '1',
        requestedAmount: 10000,
        requestedCreditExcessAmount: 5000,
        reasonText: '',
        requestedBy: 7,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('Step B request — reasonText 200자 초과 시 BadRequest', async () => {
    await expect(
      sut.request({
        orderId: 1,
        walletAccountId: '1',
        requestedAmount: 10000,
        requestedCreditExcessAmount: 5000,
        reasonText: 'a'.repeat(201),
        requestedBy: 7,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('Step B request — PENDING 으로 저장', async () => {
    const r = await sut.request({
      orderId: 1,
      walletAccountId: '1',
      requestedAmount: 10000,
      requestedCreditExcessAmount: 5000,
      reasonText: '신규 발송건 한도 임시 초과',
      requestedBy: 7,
    });
    expect(r.status).toBe(CreditExcessApprovalStatus.PENDING);
    expect(repo.save).toHaveBeenCalled();
  });

  it('Step C approve — PENDING → APPROVED + approvedBy/approvedAt 갱신', async () => {
    repo.findOne.mockResolvedValue({ id: 'a1', status: CreditExcessApprovalStatus.PENDING } as any);
    const r = await sut.approve('a1', 99);
    expect(r.status).toBe(CreditExcessApprovalStatus.APPROVED);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: CreditExcessApprovalStatus.APPROVED, approvedBy: 99 }),
    );
  });

  it('이미 APPROVED 상태에서 approve 재호출 → BadRequest', async () => {
    repo.findOne.mockResolvedValue({ id: 'a1', status: CreditExcessApprovalStatus.APPROVED } as any);
    await expect(sut.approve('a1', 99)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('Step C reject — reject_reason 필수', async () => {
    repo.findOne.mockResolvedValue({ id: 'a1', status: CreditExcessApprovalStatus.PENDING } as any);
    await expect(sut.reject('a1', 99, '')).rejects.toBeInstanceOf(BadRequestException);
    const r = await sut.reject('a1', 99, '한도 부족');
    expect(r.status).toBe(CreditExcessApprovalStatus.REJECTED);
    expect(r.rejectReason).toBe('한도 부족');
  });

  it('Step D consume — APPROVED + 미사용 + orderId/amount 일치 시 affectedRows=1', async () => {
    repo.findOne.mockResolvedValue({
      id: 'a1',
      orderId: 1,
      requestedCreditExcessAmount: 5000,
      status: CreditExcessApprovalStatus.APPROVED,
      consumedAt: null,
    } as any);
    await expect(sut.consume('a1', 1, 5000)).resolves.toBeUndefined();
  });

  it('Step D consume — orderId 불일치 → Forbidden', async () => {
    repo.findOne.mockResolvedValue({
      id: 'a1',
      orderId: 1,
      requestedCreditExcessAmount: 5000,
      status: CreditExcessApprovalStatus.APPROVED,
      consumedAt: null,
    } as any);
    await expect(sut.consume('a1', 999, 5000)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('Step D consume — amount 불일치 → Forbidden', async () => {
    repo.findOne.mockResolvedValue({
      id: 'a1',
      orderId: 1,
      requestedCreditExcessAmount: 5000,
      status: CreditExcessApprovalStatus.APPROVED,
      consumedAt: null,
    } as any);
    await expect(sut.consume('a1', 1, 9999)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('Step D consume — 이미 consumed → Forbidden (race) 시 affectedRows=0', async () => {
    repo.findOne.mockResolvedValue({
      id: 'a1',
      orderId: 1,
      requestedCreditExcessAmount: 5000,
      status: CreditExcessApprovalStatus.APPROVED,
      consumedAt: null,
    } as any);
    repo.createQueryBuilder = jest.fn().mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    });
    await expect(sut.consume('a1', 1, 5000)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
