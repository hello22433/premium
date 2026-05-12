import { OrderService } from './order.service';

describe('OrderService card surcharge resolution', () => {
  const createService = (settleMethod: string | null) => {
    const service = Object.create(OrderService.prototype) as any;
    service.userRepository = {
      findOne: jest.fn().mockResolvedValue({
        company: {
          settleMethod,
        },
      }),
    };
    return service;
  };

  it('정산 주체 회사의 정산 방식이 CARD이면 true를 반환한다', async () => {
    const service = createService('CARD');

    await expect(service.resolveCardSurchargeApplied(1)).resolves.toBe(true);
    expect(service.userRepository.findOne).toHaveBeenCalledWith({
      where: { id: 1 },
      relations: ['company'],
    });
  });

  it('정산 주체 회사의 정산 방식이 CARD가 아니면 false를 반환한다', async () => {
    const service = createService('CASH');

    await expect(service.resolveCardSurchargeApplied(1)).resolves.toBe(false);
  });
});
