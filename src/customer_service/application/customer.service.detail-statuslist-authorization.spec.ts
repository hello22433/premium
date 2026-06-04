import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CustomerServiceService } from './customer.service.service';
import { IProductType } from '../../product/interface/product.type';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

/**
 * MEDIUM 회귀 잠금 — getDetailList(빈 페이지 우회) / mapStatusList(변경이력 권한검사).
 *
 * 이 PR의 핵심은 unmasked-delivery-target 외에도 두 가지가 더 있다:
 *  1) getDetailList 의 productTypeRows "선검사" — 페이지네이션과 분리된 distinct product.type 조회로
 *     권한을 검증한다. 페이지네이션된 결과로 검사하면 빈 페이지(범위 밖) 요청 시 검사가 스킵되어
 *     totalCount/totalPage 로 주문 존재·발송 건수가 노출된다.
 *  2) mapStatusList 의 권한검사 — 변경이력 조회/복호화(execStatusList)는 mapStatusList 통과 이후에만
 *     일어나야 한다. 무권한자는 이력의 암호화된 수신정보를 복호화할 수 없어야 한다.
 *
 * 생성자 의존성이 많아 Object.create 로 생성자 우회 후 메서드만 격리 테스트한다.
 * (customer.service.unmasked-authorization.spec.ts 와 동일 패턴)
 */
describe('CustomerServiceService — CS 조회 API 권한검사(MEDIUM)', () => {
  const operator = { id: 9, email: 'op@enmad.com' } as any;

  // createQueryBuilder 체인을 흉내내는 목. 모든 빌더 메서드는 자기 자신을 반환하고,
  // 종단 메서드(getRawMany / getManyAndCount)만 결과를 돌려준다.
  const makeQueryBuilder = (productTypeRows: any[], manyAndCount: [any[], number]) => {
    const qb: any = {};
    const chainMethods = [
      'innerJoinAndSelect',
      'innerJoin',
      'leftJoinAndSelect',
      'leftJoinAndMapOne',
      'where',
      'take',
      'skip',
      'select',
      'orderBy',
      'andWhere',
    ];
    for (const m of chainMethods) qb[m] = jest.fn().mockReturnValue(qb);
    qb.getRawMany = jest.fn().mockResolvedValue(productTypeRows); // 선검사용 distinct product.type
    qb.getManyAndCount = jest.fn().mockResolvedValue(manyAndCount); // 페이지네이션 결과
    return qb;
  };

  // ===========================================================================
  // getDetailList — 빈 페이지 우회 차단
  // ===========================================================================
  describe('getDetailList — 빈 페이지(범위 밖) 우회 차단', () => {
    const makeSut = (productTypeRows: any[], manyAndCount: [any[], number], authImpl?: jest.Mock) => {
      const qb = makeQueryBuilder(productTypeRows, manyAndCount);
      const sut: any = Object.create(CustomerServiceService.prototype);
      sut.orderDeliveryRepository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
      sut.authService = { authorityValidator: authImpl ?? jest.fn().mockResolvedValue(undefined) };
      sut.cryptoCipher = { safeDecryptDeliveryTarget: jest.fn().mockReturnValue('user@test.com') };
      return { sut, qb };
    };

    it('범위 밖 빈 페이지를 요청해도 권한검사를 수행하고, 무권한자는 거부된다(건수 미노출)', async () => {
      // 주문은 일반 쿠폰 발송으로 존재하지만, 요청 page 가 범위를 벗어나 페이지 결과는 비어 있다.
      const { sut, qb } = makeSut(
        [{ type: IProductType.GENERAL }],
        [[], 0],
        jest.fn().mockRejectedValue(new ForbiddenException('권한이 없습니다.')),
      );

      await expect(sut.getDetailList(operator, { orderId: 100, page: 999, take: 10 })).rejects.toThrow(
        ForbiddenException,
      );

      // 핵심: 권한검사는 페이지 결과가 아니라 distinct product.type(선검사)로 구동된다.
      expect(qb.getRawMany).toHaveBeenCalled();
      expect(sut.authService.authorityValidator).toHaveBeenCalledWith(
        operator,
        UserAuthSubEnum.CUSTOMER_GENERAL_COUPON,
      );
      // 거부되었으므로 페이지네이션 집계(getManyAndCount)에 도달하지 않는다 → totalCount/totalPage 미노출.
      expect(qb.getManyAndCount).not.toHaveBeenCalled();
    });

    it('존재하지 않는 주문이면 400, 권한검사에 도달하지 않는다', async () => {
      const { sut, qb } = makeSut([], [[], 0]); // productTypeRows 비어 있음

      await expect(sut.getDetailList(operator, { orderId: 404, page: 1, take: 10 })).rejects.toThrow(
        BadRequestException,
      );
      await expect(sut.getDetailList(operator, { orderId: 404, page: 1, take: 10 })).rejects.toThrow(
        '존재하지 않는 주문입니다.',
      );
      expect(sut.authService.authorityValidator).not.toHaveBeenCalled();
      expect(qb.getManyAndCount).not.toHaveBeenCalled();
    });

    it('주문에 일반+SSG 발송이 섞이면 두 쿠폰 권한을 모두 요구한다', async () => {
      const validator = jest.fn().mockResolvedValue(undefined);
      const { sut } = makeSut(
        [{ type: IProductType.GENERAL }, { type: IProductType.SSG }],
        [[], 0],
        validator,
      );

      await sut.getDetailList(operator, { orderId: 100, page: 1, take: 10 });

      expect(validator).toHaveBeenCalledWith(operator, UserAuthSubEnum.CUSTOMER_GENERAL_COUPON);
      expect(validator).toHaveBeenCalledWith(operator, UserAuthSubEnum.CUSTOMER_SSG_COUPON);
    });

    it('권한 통과 시에는 빈 페이지여도 정상 응답(totalCount 0)을 반환한다', async () => {
      const { sut, qb } = makeSut([{ type: IProductType.GENERAL }], [[], 0]);

      const result = await sut.getDetailList(operator, { orderId: 100, page: 999, take: 10 });

      expect(qb.getManyAndCount).toHaveBeenCalled();
      expect(result.totalCount).toBe(0);
      expect(result.list).toEqual([]);
    });
  });

  // ===========================================================================
  // mapStatusList — 변경이력 조회/복호화 권한검사
  // ===========================================================================
  describe('statusList — 무권한자는 변경이력 조회/복호화 불가', () => {
    const buildOrderDelivery = (productType?: IProductType) =>
      ({
        id: 5001,
        orderProductMapping: { product: productType ? { type: productType } : undefined },
      }) as any;

    const makeSut = (orderDelivery: any, authImpl?: jest.Mock) => {
      const sut: any = Object.create(CustomerServiceService.prototype);
      sut.orderDeliveryRepository = { findOne: jest.fn().mockResolvedValue(orderDelivery) };
      sut.authService = { authorityValidator: authImpl ?? jest.fn().mockResolvedValue(undefined) };
      // execStatusList 가 도달하면 복호화가 일어나는지 감시하기 위한 목.
      sut.cryptoCipher = { safeDecryptDeliveryTarget: jest.fn().mockReturnValue('user@test.com') };
      // 권한 통과(happy path) 시 execStatusList 가 조회할 이력 목.
      const historyQb: any = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest
          .fn()
          .mockResolvedValue([[{ id: 1, type: '수신정보 변경요청', beforeChange: 'enc1', afterChange: 'enc2' }], 1]),
      };
      sut.orderHistoryRepository = { createQueryBuilder: jest.fn().mockReturnValue(historyQb) };
      return sut;
    };

    // 컨트롤러 흐름(map → exec)을 그대로 재현한다. map 이 막히면 exec(복호화)에 절대 도달하지 못한다.
    const runMapThenExec = async (sut: any, query: any) => {
      const map = await sut.mapStatusList(operator, query);
      return sut.execStatusList(map);
    };

    it('권한 없는 사용자는 mapStatusList 에서 거부되어 이력 조회/복호화에 도달하지 못한다', async () => {
      const sut = makeSut(
        buildOrderDelivery(IProductType.GENERAL),
        jest.fn().mockRejectedValue(new ForbiddenException('권한이 없습니다.')),
      );

      await expect(runMapThenExec(sut, { orderDeliveryId: 5001, page: 1, take: 10 })).rejects.toThrow(
        ForbiddenException,
      );
      // 권한검사가 execStatusList(복호화)보다 먼저 → 암호화된 수신정보 복호화 미발생.
      expect(sut.orderHistoryRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(sut.cryptoCipher.safeDecryptDeliveryTarget).not.toHaveBeenCalled();
    });

    it('존재하지 않는 발송 정보면 400, 권한검사에 도달하지 않는다', async () => {
      const sut = makeSut(null);

      await expect(sut.mapStatusList(operator, { orderDeliveryId: 5001, page: 1, take: 10 })).rejects.toThrow(
        '존재하지 않는 발송 정보입니다.',
      );
      expect(sut.authService.authorityValidator).not.toHaveBeenCalled();
    });

    it('CS 대상이 아닌 상품 유형이면 400, 권한검사에 도달하지 않는다', async () => {
      const sut = makeSut(buildOrderDelivery(undefined));

      await expect(sut.mapStatusList(operator, { orderDeliveryId: 5001, page: 1, take: 10 })).rejects.toThrow(
        'CS 대상이 아닌 상품 유형입니다.',
      );
      expect(sut.authService.authorityValidator).not.toHaveBeenCalled();
    });

    it('SSG 발송의 변경이력은 CUSTOMER_SSG_COUPON 권한을 요구한다', async () => {
      const sut = makeSut(buildOrderDelivery(IProductType.SSG));

      const map = await sut.mapStatusList(operator, { orderDeliveryId: 5001, page: 1, take: 10 });

      expect(sut.authService.authorityValidator).toHaveBeenCalledWith(operator, UserAuthSubEnum.CUSTOMER_SSG_COUPON);
      expect(map.orderDeliveryId).toBe(5001);
    });

    it('권한 통과 시에는 변경이력 복호화가 정상 수행된다', async () => {
      const sut = makeSut(buildOrderDelivery(IProductType.GENERAL));

      const result = await runMapThenExec(sut, { orderDeliveryId: 5001, page: 1, take: 10 });

      expect(sut.authService.authorityValidator).toHaveBeenCalledWith(
        operator,
        UserAuthSubEnum.CUSTOMER_GENERAL_COUPON,
      );
      // 수신정보 변경요청 이력의 before/after 가 복호화되어 반환된다.
      expect(sut.cryptoCipher.safeDecryptDeliveryTarget).toHaveBeenCalled();
      expect(result.list[0].beforeChange).toBe('user@test.com');
    });
  });
});
