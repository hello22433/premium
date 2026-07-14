import { BadRequestException } from '@nestjs/common';
import { ProductService } from './product.service';

/**
 * 상품목록 유효기간(expireDayMin/Max) 필터 배선 회귀 테스트.
 *
 * 필터 로직 자체(범위 조건, 열린 경계, min > max 400)는 공통 헬퍼 스펙
 * (query.builder.expire.day.condition.spec.ts)에서 검증한다. 여기서는 getTotalList/getList 가
 * 올바른 컬럼(product.expireDay)으로 헬퍼를 호출하는지(배선)와 가드 순서(쿼리 실행 전 400)만 확인한다.
 *
 * 생성자 의존성이 많아 Object.create 로 생성자 우회 후 협력자만 mock 주입한다.
 * (customer.service.expire-day-filter.spec 관례)
 */

const buildQueryBuilderMock = () => {
  const qb: any = {};
  const chainMethods = ['innerJoinAndSelect', 'leftJoinAndSelect', 'andWhere', 'orderBy', 'skip', 'take'];
  chainMethods.forEach((m) => {
    qb[m] = jest.fn().mockReturnValue(qb);
  });
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb;
};

describe('ProductService — 유효기간(expireDay) 범위 필터 배선', () => {
  let service: any;
  let qb: any;
  let productRepository: any;

  // CORPORATE_ADMIN 분기(연동상품 제한)를 타지 않는 자사직원 기준
  const baseUser = { id: 1, authority: 'SUPER_ADMIN' } as any;
  const baseQuery = { page: 1, take: 10 } as any;

  beforeEach(() => {
    qb = buildQueryBuilderMock();
    productRepository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };

    service = Object.create(ProductService.prototype);
    service.productRepository = productRepository;
    service.productUpdateHistoryRepository = { find: jest.fn().mockResolvedValue([]) };
  });

  describe.each(['getTotalList', 'getList'] as const)('%s', (method) => {
    it('expireDayMin/Max 전송 시 product.expireDay 범위 조건을 적용한다', async () => {
      await service[method](baseUser, { ...baseQuery, expireDayMin: 59, expireDayMax: 61 });

      expect(qb.andWhere).toHaveBeenCalledWith('product.expireDay >= :expireDayMin', { expireDayMin: 59 });
      expect(qb.andWhere).toHaveBeenCalledWith('product.expireDay <= :expireDayMax', { expireDayMax: 61 });
    });

    it('미전송 시 유효기간 조건을 추가하지 않는다 (기존 동작 보존)', async () => {
      await service[method](baseUser, { ...baseQuery });

      const expireDayCalls = qb.andWhere.mock.calls.filter((c: any[]) => String(c[0]).includes('expireDay'));
      expect(expireDayCalls).toHaveLength(0);
    });

    it('min > max 이면 쿼리 실행 전에 400 을 던진다', async () => {
      await expect(service[method](baseUser, { ...baseQuery, expireDayMin: 61, expireDayMax: 59 })).rejects.toThrow(
        BadRequestException,
      );
      expect(productRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
