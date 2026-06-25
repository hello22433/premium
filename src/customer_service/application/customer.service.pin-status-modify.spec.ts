import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { CustomerServiceService } from './customer.service.service';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';

/**
 * 핀상태변경(execPinStatusModify) terminal/CAS/트랜잭션 회귀 테스트.
 *
 * 검증 대상 (폐기 execDiscard 와 동일 결함을 봉합):
 *  (A) terminal 재진입 차단 — beforeChange 가 terminal(USED/CANCEL/REFUND_CANCEL)이면
 *      switch(외부 cancel/Tx) 이전에 거부. 분기별 가드 누락(협력사 REFUND_CANCEL,
 *      SSG CANCEL·REFUND_CANCEL, default 무가드)을 switch 앞 공통 가드로 봉합.
 *  (B) CAS — 조건부 UPDATE affected=0(경합) 이면 throw + 롤백, commit 미수행.
 *  (C) 정상경로 — affected=1 이면 commit + 이력 저장(한 트랜잭션).
 *  (D) 외부 cancel 실패(throw) 시 그대로 전파 + DB 트랜잭션 미진입 (D3-46: cancel 은 실패를 throw 로 알림).
 *
 * execPinStatusModify 는 map 을 직접 받으므로(컨트롤러가 mapPinStatusModify 로 구성),
 * 생성자를 Object.create 로 우회하고 dataSource/협력자만 mock 주입한다. (discard-concurrency.spec 관례)
 */
describe('CustomerServiceService.execPinStatusModify — terminal / CAS / 트랜잭션', () => {
  const buildMap = (overrides: Record<string, any> = {}) =>
    ({
      businessName: '갤럭시아',
      beforeChange: OrderDeliveryCouponStatus.NOT_USED,
      afterChange: 'CANCEL',
      type: '핀상태 변경',
      content: '핀상태 변경',
      userId: 9,
      orderDelivery: { id: 5001, userId: 42 },
      ...overrides,
    }) as any;

  const makeSut = (txAffected: number, cancelMessage = '폐기 완료') => {
    const sut: any = Object.create(CustomerServiceService.prototype);
    const tx = makeTxRunner(txAffected);
    sut.dataSource = { createQueryRunner: jest.fn(() => tx) };
    sut.orderHistoryRepository = { create: jest.fn(() => ({})) };
    sut.partnerCompanyExternService = { cancel: jest.fn().mockResolvedValue({ message: cancelMessage }) };
    return { sut, tx };
  };

  describe('(A) terminal 재진입 차단 — switch 앞 공통 가드', () => {
    const terminals = [
      OrderDeliveryCouponStatus.USED,
      OrderDeliveryCouponStatus.CANCEL,
      OrderDeliveryCouponStatus.REFUND_CANCEL,
    ];

    it.each(terminals)('협력사: beforeChange=%s 이면 외부 cancel/Tx 이전에 거부', async (terminal) => {
      const { sut } = makeSut(1);

      await expect(
        sut.execPinStatusModify(buildMap({ businessName: '갤럭시아', beforeChange: terminal })),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(sut.partnerCompanyExternService.cancel).not.toHaveBeenCalled();
      expect(sut.dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    // 이전 SSG 가드는 USED/EXPIRED 만 막아 CANCEL/REFUND_CANCEL 이 통과했음 — 본 수정으로 차단됨을 검증
    it.each(terminals)('SSG: beforeChange=%s 이면 Tx 이전에 거부(기존 누락 봉합)', async (terminal) => {
      const { sut } = makeSut(1);

      await expect(
        sut.execPinStatusModify(buildMap({ businessName: 'SSG', beforeChange: terminal, afterChange: 'REFUND_CANCEL' })),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(sut.dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    // default 분기는 이전에 무가드였음 — 공통 가드가 앞에서 terminal 을 막는지 검증
    it('default(미지정 협력사): terminal(REFUND_CANCEL)도 이제 차단(이전엔 무가드)', async () => {
      const { sut } = makeSut(1);

      await expect(
        sut.execPinStatusModify(
          buildMap({ businessName: '알수없는협력사', beforeChange: OrderDeliveryCouponStatus.REFUND_CANCEL }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(sut.dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('협력사: EXPIRED 는 분기 잔여 가드로 차단', async () => {
      const { sut } = makeSut(1);

      await expect(
        sut.execPinStatusModify(buildMap({ businessName: '갤럭시아', beforeChange: OrderDeliveryCouponStatus.EXPIRED })),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(sut.partnerCompanyExternService.cancel).not.toHaveBeenCalled();
    });

    it('SSG: EXPIRED 는 현행 보존대로 전면 차단', async () => {
      const { sut } = makeSut(1);

      await expect(
        sut.execPinStatusModify(buildMap({ businessName: 'SSG', beforeChange: OrderDeliveryCouponStatus.EXPIRED })),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(sut.dataSource.createQueryRunner).not.toHaveBeenCalled();
    });
  });

  describe('(B) CAS — affected=0(경합) 멱등 차단', () => {
    it('협력사: 외부 cancel 성공 후 CAS affected=0 이면 throw + 롤백, commit 미수행', async () => {
      const { sut, tx } = makeSut(0, '폐기 완료');

      await expect(
        sut.execPinStatusModify(buildMap({ beforeChange: OrderDeliveryCouponStatus.NOT_USED })),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(sut.partnerCompanyExternService.cancel).toHaveBeenCalledTimes(1); // 외부는 선행 호출됨
      expect(tx.rollbackTransaction).toHaveBeenCalled();
      expect(tx.commitTransaction).not.toHaveBeenCalled();
    });
  });

  describe('(C) 정상경로 — affected=1 commit + 이력', () => {
    it('협력사: cancel 성공 + CAS affected=1 이면 commit + 이력 저장', async () => {
      const { sut, tx } = makeSut(1, '폐기 완료');

      await expect(
        sut.execPinStatusModify(buildMap({ beforeChange: OrderDeliveryCouponStatus.NOT_USED })),
      ).resolves.toBeUndefined();

      expect(tx.commitTransaction).toHaveBeenCalled();
      expect(sut.orderHistoryRepository.create).toHaveBeenCalled();
      expect(tx.manager.save).toHaveBeenCalledTimes(1); // 이력 저장
      // CAS 는 beforeChange 를 조건으로 사용
      expect(tx.updateBuilder.where).toHaveBeenCalledWith(
        'id = :id AND coupon_status = :before',
        { id: 5001, before: OrderDeliveryCouponStatus.NOT_USED },
      );
    });

    it('SSG: 외부 cancel 없이 CAS+이력으로 처리', async () => {
      const { sut, tx } = makeSut(1);

      await expect(
        sut.execPinStatusModify(
          buildMap({ businessName: 'SSG', beforeChange: OrderDeliveryCouponStatus.NOT_USED, afterChange: 'REFUND_CANCEL' }),
        ),
      ).resolves.toBeUndefined();

      expect(sut.partnerCompanyExternService.cancel).not.toHaveBeenCalled();
      expect(tx.commitTransaction).toHaveBeenCalled();
      expect(tx.manager.save).toHaveBeenCalledTimes(1);
    });

    it('default(미지정 협력사): CAS 로 상태만 보정, 이력 저장 없음', async () => {
      const { sut, tx } = makeSut(1);

      await expect(
        sut.execPinStatusModify(
          buildMap({ businessName: '알수없는협력사', beforeChange: OrderDeliveryCouponStatus.NOT_USED, afterChange: 'CANCEL' }),
        ),
      ).resolves.toBeUndefined();

      expect(tx.commitTransaction).toHaveBeenCalled();
      expect(tx.manager.save).not.toHaveBeenCalled(); // 이력 없음(현행 동작 보존)
    });
  });

  describe('(D) 외부 cancel 실패(throw) 전파', () => {
    it('협력사: cancel 이 throw 하면 그대로 전파 + DB 트랜잭션 미진입 (D3-46)', async () => {
      const { sut } = makeSut(1);
      // 어댑터 cancel()은 실패를 '반환값'이 아니라 throw 로 알린다(galaxia/giftiel/giftishow/culture/daou 공통).
      // 옛 `result.message !== '폐기 완료'` 분기는 cancel 이 성공 시 항상 '폐기 완료'만 반환하므로 데드코드였음.
      sut.partnerCompanyExternService.cancel = jest
        .fn()
        .mockRejectedValue(new InternalServerErrorException('협력사 오류'));

      await expect(
        sut.execPinStatusModify(buildMap({ beforeChange: OrderDeliveryCouponStatus.NOT_USED })),
      ).rejects.toBeInstanceOf(InternalServerErrorException);

      // cancel 이 throw → commitPinStatusTransition(=createQueryRunner) 도달 전에 전파
      expect(sut.dataSource.createQueryRunner).not.toHaveBeenCalled();
    });
  });

  describe('(E) mapPinStatusModify — 초이스쿠폰 businessName 라우팅 (F1)', () => {
    const operator = { id: 9 } as any;
    const makeMapSut = (orderDelivery: any) => {
      const sut: any = Object.create(CustomerServiceService.prototype);
      sut.orderDeliveryRepository = { findOne: jest.fn().mockResolvedValue(orderDelivery) };
      return sut;
    };

    it('초이스쿠폰은 선택 상품 협력사를 businessName 으로 반환(원상품 아님) — 외부 cancel 분기로 정확히 라우팅', async () => {
      const sut = makeMapSut({
        couponStatus: OrderDeliveryCouponStatus.NOT_USED,
        orderProductMapping: { product: { partnerCompany: { businessName: 'SSG' } } },
        choiceSelectProduct: { partnerCompany: { businessName: '갤럭시아' } },
      });

      const map = await sut.mapPinStatusModify(operator, { orderDeliveryId: 5001, afterChange: 'CANCEL' });

      // 원상품(SSG) 이 아니라 선택 상품(갤럭시아 = 실제 PIN 발행처) 으로 라우팅돼야 함
      expect(map.businessName).toBe('갤럭시아');
    });

    it('초이스 없으면 원상품 협력사로 폴백', async () => {
      const sut = makeMapSut({
        couponStatus: OrderDeliveryCouponStatus.NOT_USED,
        orderProductMapping: { product: { partnerCompany: { businessName: '컬쳐랜드' } } },
        choiceSelectProduct: null,
      });

      const map = await sut.mapPinStatusModify(operator, { orderDeliveryId: 5001, afterChange: 'CANCEL' });

      expect(map.businessName).toBe('컬쳐랜드');
    });
  });

  describe('(F) default 분기 — 허용 상태 제한 (F2)', () => {
    it('default 에서 afterChange 가 CANCEL/REFUND_CANCEL 이 아니면 거부 + Tx 미진입(상태컬럼 오염 방지)', async () => {
      const { sut } = makeSut(1);

      await expect(
        sut.execPinStatusModify(
          buildMap({
            businessName: '알수없는협력사',
            beforeChange: OrderDeliveryCouponStatus.NOT_USED,
            afterChange: 'USED', // 임의/비허용 상태
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(sut.dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('default 에서 CANCEL 은 정상 처리(CAS commit)', async () => {
      const { sut, tx } = makeSut(1);

      await expect(
        sut.execPinStatusModify(
          buildMap({
            businessName: '알수없는협력사',
            beforeChange: OrderDeliveryCouponStatus.NOT_USED,
            afterChange: 'CANCEL',
          }),
        ),
      ).resolves.toBeUndefined();

      expect(tx.commitTransaction).toHaveBeenCalled();
    });
  });

  // queryRunner mock — manager.createQueryBuilder().update().set().where().execute() => {affected}
  function makeTxRunner(affected: number) {
    const ub: any = {};
    for (const m of ['update', 'set', 'where']) ub[m] = jest.fn(() => ub);
    ub.execute = jest.fn().mockResolvedValue({ affected });
    const manager = {
      createQueryBuilder: jest.fn(() => ub),
      save: jest.fn().mockResolvedValue(undefined),
    };
    return {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager,
      updateBuilder: ub, // 테스트에서 where 인자 검증용
    } as any;
  }
});
