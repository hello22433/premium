jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_t: unknown, _k: unknown, descriptor: unknown) => descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { BadRequestException } from '@nestjs/common';
import { UserDiscountService } from './user.discount.service';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserDiscountCategory } from '../interface/user.discount.category';
import { IUserDiscountMethod } from '../interface/user.discount.method';
import { ICompareCondition } from '../interface/compare.condition';
import { IPriceAdjustment } from '../interface/price.adjustment';

/**
 * 협력사 정산조건(partner scope) 쓰기 경로.
 *
 * 이 경로가 어긋나면 원장이 매입 할인율을 못 찾아 0% 로 계산하거나, 삭제된 할인을 계속 적용한다.
 */
describe('UserDiscountService — 협력사 정산조건 쓰기', () => {
  const loginUser = { id: 9, email: 'admin@example.com', authority: IUserAuthority.OPERATION_ADMIN } as any;

  let userDiscountRepository: any;
  let userRepository: any;
  let classificationRepository: any;
  let historyService: any;
  let service: UserDiscountService;

  beforeEach(() => {
    const queryBuilder = {
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
      getMany: jest.fn().mockResolvedValue([]),
    };

    userDiscountRepository = {
      createQueryBuilder: jest.fn(() => queryBuilder),
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 1 }] }),
      findOne: jest.fn(),
      softDelete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    userRepository = { findOneBy: jest.fn().mockResolvedValue({ id: 3 }) };
    classificationRepository = { findOneBy: jest.fn().mockResolvedValue({ id: 1 }) };
    historyService = {
      lockPolicy: jest.fn().mockResolvedValue(undefined),
      recordCreate: jest.fn().mockResolvedValue(undefined),
      recordDelete: jest.fn().mockResolvedValue(undefined),
      bumpEpoch: jest.fn().mockResolvedValue(undefined),
    };

    service = new UserDiscountService(userDiscountRepository, userRepository, classificationRepository, historyService);
  });

  function body(overrides: Record<string, unknown> = {}) {
    return {
      partnerCompanyId: 4,
      category: IUserDiscountCategory.PRODUCT_GROUP,
      group: '모바일쿠폰',
      method: IUserDiscountMethod.BULK,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      pricePercent: 5,
      ...overrides,
    } as any;
  }

  describe('scope 배타 검증', () => {
    it('협력사 할인에 userId 가 함께 오면 거부한다', async () => {
      // 둘 다 채워지면 이력 대상 판정에서 빠져 원장이 그 할인을 영영 못 본다.
      await expect(service.createInTransaction(loginUser, body({ userId: 3 }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(userDiscountRepository.insert).not.toHaveBeenCalled();
    });

    it('userId 도 partnerCompanyId 도 없으면 거부한다', async () => {
      await expect(
        service.createInTransaction(loginUser, body({ partnerCompanyId: undefined })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('협력사 할인은 사용자 조회를 하지 않는다', async () => {
      await service.createInTransaction(loginUser, body());

      expect(userRepository.findOneBy).not.toHaveBeenCalled();
    });

    it('사용자 할인은 기존 경로대로 사용자 존재를 확인한다', async () => {
      await service.createInTransaction(loginUser, body({ partnerCompanyId: undefined, userId: 3 }));

      expect(userRepository.findOneBy).toHaveBeenCalledWith({ id: 3 });
      expect(historyService.lockPolicy).not.toHaveBeenCalled();
      expect(historyService.recordCreate).not.toHaveBeenCalled();
    });
  });

  describe('이력 기록', () => {
    it('잠금 → 원본 INSERT → 이력 기록 → epoch 증가 순으로 진행한다', async () => {
      const order: string[] = [];
      historyService.lockPolicy.mockImplementation(async () => void order.push('lock'));
      userDiscountRepository.insert.mockImplementation(async () => {
        order.push('insert');
        return { identifiers: [{ id: 1 }] };
      });
      historyService.recordCreate.mockImplementation(async () => void order.push('history'));
      historyService.bumpEpoch.mockImplementation(async () => void order.push('epoch'));

      await service.createInTransaction(loginUser, body());

      expect(order).toEqual(['lock', 'insert', 'history', 'epoch']);
    });

    it('중복 검증을 잠금 획득 뒤에 수행한다', async () => {
      // 잠금 밖에서 검증하면 같은 대상의 동시 요청 2건이 모두 통과한다.
      const order: string[] = [];
      historyService.lockPolicy.mockImplementation(async () => void order.push('lock'));
      userDiscountRepository.createQueryBuilder.mockImplementation(() => {
        order.push('validate');
        return { andWhere: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue(null) };
      });

      await service.createInTransaction(loginUser, body());

      expect(order).toEqual(['lock', 'validate']);
    });

    it('이력 기록이 실패하면 오류를 삼키지 않는다', async () => {
      historyService.recordCreate.mockRejectedValue(new Error('history down'));

      await expect(service.createInTransaction(loginUser, body())).rejects.toThrow('history down');
    });
  });

  describe('구간 표기 정규화', () => {
    it('저장값과 이력 scope 가 같은 canonical 구간을 쓴다', async () => {
      await service.createInTransaction(
        loginUser,
        body({
          method: IUserDiscountMethod.SECTION,
          compareCondition: ICompareCondition.MORE,
          range: ' 10000 ',
        }),
      );

      // 저장만 원문으로 두면 "10000" 과 " 10000 " 이 원본에는 둘 다 남고 이력은 하나로 합쳐진다.
      expect(userDiscountRepository.insert).toHaveBeenCalledWith(expect.objectContaining({ range: '10000' }));
      expect(historyService.recordCreate).toHaveBeenCalledWith(
        expect.objectContaining({ range: '10000' }),
        expect.anything(),
        loginUser.id,
        expect.any(Date),
      );
    });

    it('일괄 할인은 구간 없이 저장한다', async () => {
      await service.createInTransaction(loginUser, body({ range: '10000' }));

      expect(userDiscountRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ range: null, compareCondition: ICompareCondition.ALL }),
      );
    });
  });

  describe('삭제', () => {
    it('협력사 할인 삭제는 tombstone 을 남긴다', async () => {
      userDiscountRepository.findOne.mockResolvedValue({
        id: 5,
        userId: null,
        partnerCompanyId: 4,
        category: IUserDiscountCategory.PRODUCT_GROUP,
        classificationId: null,
        method: IUserDiscountMethod.BULK,
        primaryCategory: null,
        group: '모바일쿠폰',
        range: null,
        compareCondition: ICompareCondition.ALL,
      });

      await service.deleteInTransaction(loginUser, { id: 5 } as any);

      expect(historyService.lockPolicy).toHaveBeenCalled();
      expect(userDiscountRepository.softDelete).toHaveBeenCalledWith(5);
      expect(historyService.recordDelete).toHaveBeenCalledWith(
        expect.objectContaining({ partnerCompanyId: 4 }),
        loginUser.id,
        expect.any(Date),
      );
      expect(historyService.bumpEpoch).toHaveBeenCalledWith(4);
    });

    it('사용자 할인 삭제는 협력사 이력을 건드리지 않는다', async () => {
      userDiscountRepository.findOne.mockResolvedValue({
        id: 6,
        userId: 3,
        partnerCompanyId: null,
        category: IUserDiscountCategory.PRODUCT_GROUP,
        classificationId: null,
        method: IUserDiscountMethod.BULK,
        primaryCategory: null,
        group: '모바일쿠폰',
        range: null,
        compareCondition: ICompareCondition.ALL,
      });

      await service.deleteInTransaction(loginUser, { id: 6 } as any);

      expect(historyService.recordDelete).not.toHaveBeenCalled();
      expect(userDiscountRepository.softDelete).toHaveBeenCalledWith(6);
    });
  });
});
