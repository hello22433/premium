import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrderEntity } from '../../entity/order.entity';
import { PointGrantEntity } from '../../entity/point.grant.entity';
import { PointPolicyEffect } from '../interface/point-policy-scope';
import { PointPolicyService } from './point-policy.service';
import { WalletAllocationInputBuilder } from './wallet-allocation-input.builder';

describe('WalletAllocationInputBuilder', () => {
  let sut: WalletAllocationInputBuilder;
  let pointPolicyService: { evaluate: jest.Mock };
  let pointGrantRepo: jest.Mocked<Pick<Repository<PointGrantEntity>, 'find'>>;

  beforeEach(async () => {
    pointPolicyService = { evaluate: jest.fn().mockResolvedValue(PointPolicyEffect.ALLOW) };
    pointGrantRepo = { find: jest.fn() } as unknown as jest.Mocked<Pick<Repository<PointGrantEntity>, 'find'>>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletAllocationInputBuilder,
        { provide: PointPolicyService, useValue: pointPolicyService },
        { provide: getRepositoryToken(PointGrantEntity), useValue: pointGrantRepo },
      ],
    }).compile();

    sut = module.get(WalletAllocationInputBuilder);
  });

  it('후정산 + depositUseEnabled=false + 포인트 미사용 → deposit/point 0, grants 빈배열, DB 조회 없음', async () => {
    const order = {
      id: 1,
      type: 'GENERAL',
      cardSurchargeApplied: false,
      orderProductMappings: [],
    } as unknown as OrderEntity;
    const wallet = {
      id: 'w-1',
      depositBalance: 5000,
      creditLimit: 100000,
      creditUsedAmount: 0,
      settleCondition: 'POST_PAYMENT' as const,
    };

    const result = await sut.build(order, wallet, 0, {
      requestedPointAmount: 0,
      depositUseEnabled: false,
      companyId: null,
    });

    expect(result.requestedDepositAmount).toBe(0);
    expect(result.requestedPointAmount).toBe(0);
    expect(result.grants).toEqual([]);
    expect(result.isPrePayment).toBe(false);
    expect(result.lines).toEqual([]);
    expect(pointGrantRepo.find).not.toHaveBeenCalled();
  });
});
