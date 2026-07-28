import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CustomerServiceService } from './customer.service.service';
import { CustomerServiceExcelDownloadReqDto, CustomerServiceGetListReqDto } from '../api/customer.service.req.dto';

/**
 * 일반쿠폰주문CS 유효기간(expireDayMin/Max) 필터 회귀 테스트.
 *
 * 검증 대상:
 *  - getList: min/max 전송 시 COALESCE(choiceSelectProduct.expireDay, product.expireDay) 범위 조건 적용
 *    (초이스쿠폰은 선택된 상품 기준 — totalPrice 합계의 COALESCE 와 동일 기준)
 *  - getList: 미전송 시 유효기간 조건 미적용 (기존 동작 보존)
 *  - getList/excelDownload: min > max 이면 400 (공통 가드 assertExpireDayRangeValid — product.service.ts 도 동일 사용)
 *  - DTO: 쿼리스트링 숫자 변환(@Type) 및 정수/음수 검증
 *
 * 생성자 의존성이 많아 Object.create 로 생성자 우회 후 협력자만 mock 주입한다.
 * (discard-concurrency.spec 관례)
 */

// 전역 ValidationPipe({ whitelist:true, transform:true }) 검증을 재현한다.
const validateDto = async (cls: any, plain: object) => {
  const instance = plainToInstance(cls, plain, { enableImplicitConversion: false });
  const errors = await validate(instance as object, { whitelist: true, forbidUnknownValues: false });
  return { instance, errors };
};

const buildQueryBuilderMock = () => {
  const qb: any = {};
  const chainMethods = [
    'innerJoinAndSelect',
    'leftJoinAndSelect',
    'leftJoinAndMapOne',
    'andWhere',
    'take',
    'skip',
    'orderBy',
    'addOrderBy',
    'select',
  ];
  chainMethods.forEach((m) => {
    qb[m] = jest.fn().mockReturnValue(qb);
  });
  qb.clone = jest.fn().mockReturnValue(qb);
  qb.getRawOne = jest.fn().mockResolvedValue({ totalPrice: 0 });
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb;
};

describe('CustomerServiceService — 유효기간(expireDay) 범위 필터', () => {
  let service: any;
  let qb: any;
  let orderDeliveryRepository: any;

  const baseQuery = { orderType: 'GENERAL', page: 1, take: 10 } as CustomerServiceGetListReqDto;

  beforeEach(() => {
    qb = buildQueryBuilderMock();
    orderDeliveryRepository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };

    service = Object.create(CustomerServiceService.prototype);
    // §9 컷오버 게이트 — 단위 테스트 기본값은 '미전환 건'(legacy 경로 그대로 통과).
    (service as any).cutoverGuard = {
      assertLegacyAllowed: jest.fn().mockResolvedValue(undefined),
      assertRefundExecutionAllowed: jest.fn().mockResolvedValue(undefined),
      isCutover: jest.fn().mockResolvedValue(false),
      splitLegacyAllowed: jest.fn(async (ids: number[]) => ({ allowed: ids, blocked: [] })),
    };
    service.orderDeliveryRepository = orderDeliveryRepository;
  });

  describe('getList', () => {
    it('expireDayMin/Max 전송 시 COALESCE 범위 조건을 적용한다', async () => {
      await service.getList({ ...baseQuery, expireDayMin: 59, expireDayMax: 61 });

      expect(qb.andWhere).toHaveBeenCalledWith(
        'COALESCE(choiceSelectProduct.expireDay, product.expireDay) >= :expireDayMin',
        { expireDayMin: 59 },
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        'COALESCE(choiceSelectProduct.expireDay, product.expireDay) <= :expireDayMax',
        { expireDayMax: 61 },
      );
    });

    it('한쪽(min)만 전송되면 해당 조건만 적용한다', async () => {
      await service.getList({ ...baseQuery, expireDayMin: 1824 });

      expect(qb.andWhere).toHaveBeenCalledWith(
        'COALESCE(choiceSelectProduct.expireDay, product.expireDay) >= :expireDayMin',
        { expireDayMin: 1824 },
      );
      const coalesceCalls = qb.andWhere.mock.calls.filter((c: any[]) => String(c[0]).includes('COALESCE'));
      expect(coalesceCalls).toHaveLength(1);
    });

    it('미전송 시 유효기간 조건을 추가하지 않는다 (기존 동작 보존)', async () => {
      await service.getList({ ...baseQuery });

      const coalesceCalls = qb.andWhere.mock.calls.filter((c: any[]) => String(c[0]).includes('COALESCE'));
      expect(coalesceCalls).toHaveLength(0);
    });

    it('min > max 이면 쿼리 실행 전에 400 을 던진다', async () => {
      await expect(service.getList({ ...baseQuery, expireDayMin: 61, expireDayMax: 59 })).rejects.toThrow(
        BadRequestException,
      );
      expect(orderDeliveryRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('excelDownload', () => {
    it('min > max 이면 비밀번호 검증 전에 400 을 던진다', async () => {
      const activityLogService = { verifyPassword: jest.fn() };
      service.activityLogService = activityLogService;

      const dto = {
        orderType: 'GENERAL',
        password: 'pw',
        downloadReason: '사유',
        expireDayMin: 61,
        expireDayMax: 59,
      } as CustomerServiceExcelDownloadReqDto;

      await expect(service.excelDownload({ id: 1 } as any, dto, {} as any)).rejects.toThrow(BadRequestException);
      expect(activityLogService.verifyPassword).not.toHaveBeenCalled();
    });
  });
});

describe('CustomerServiceGetListReqDto — expireDayMin/Max 검증', () => {
  it('쿼리스트링 숫자("59")를 number 로 변환하고 통과시킨다', async () => {
    const { instance, errors } = await validateDto(CustomerServiceGetListReqDto, {
      orderType: 'GENERAL',
      expireDayMin: '59',
      expireDayMax: '61',
    });

    expect(errors).toHaveLength(0);
    expect((instance as CustomerServiceGetListReqDto).expireDayMin).toBe(59);
    expect((instance as CustomerServiceGetListReqDto).expireDayMax).toBe(61);
  });

  it('정수가 아니거나 음수면 검증에 실패한다', async () => {
    const { errors } = await validateDto(CustomerServiceGetListReqDto, {
      orderType: 'GENERAL',
      expireDayMin: 'abc',
      expireDayMax: -1,
    });

    const errorProps = errors.map((e) => e.property);
    expect(errorProps).toContain('expireDayMin');
    expect(errorProps).toContain('expireDayMax');
  });

  it('미전송 시 검증을 통과한다 (optional)', async () => {
    const { errors } = await validateDto(CustomerServiceGetListReqDto, { orderType: 'GENERAL' });
    expect(errors).toHaveLength(0);
  });
});
