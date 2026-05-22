jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, descriptor: PropertyDescriptor) => descriptor,
}));
import { BadRequestException } from '@nestjs/common';
import { SsgEventService } from './ssg.event.service';

describe('SsgEventService', () => {
  const createService = () => {
    const ssgEventRepository = {
      insert: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(),
    };
    const amountHistoryRepository = {
      create: jest.fn(),
      save: jest.fn(),
    };
    const orderProductMappingRepository = {};
    const reservationRangeRepository = {};
    const activityLogService = {};

    const service = new SsgEventService(
      ssgEventRepository as any,
      amountHistoryRepository as any,
      orderProductMappingRepository as any,
      reservationRangeRepository as any,
      activityLogService as any,
    );

    return { service, ssgEventRepository };
  };

  describe('create', () => {
    const dto = {
      code: 'event-key',
      no: 'event-no',
      name: 'SSG event',
      startAt: '2026-05-01T00:00:00',
      endAt: '2026-05-31T00:00:00',
      couponExpiration: 60,
      eventPrice: 10000,
    } as any;

    it('rejects zero or negative event price', async () => {
      const { service, ssgEventRepository } = createService();

      await expect(service.create({ ...dto, eventPrice: 0 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.create({ ...dto, eventPrice: -1 })).rejects.toBeInstanceOf(BadRequestException);

      expect(ssgEventRepository.insert).not.toHaveBeenCalled();
    });

    it('stores event price as the initial event balance', async () => {
      const { service, ssgEventRepository } = createService();

      await service.create(dto);

      expect(ssgEventRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          eventPrice: dto.eventPrice,
          eventBalance: dto.eventPrice,
        }),
      );
    });
  });

  describe('updateAmount', () => {
    it('rejects zero or negative charge amount before loading the event', async () => {
      const { service, ssgEventRepository } = createService();

      await expect(service.updateAmount({ id: 1, amount: 0 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.updateAmount({ id: 1, amount: -1 })).rejects.toBeInstanceOf(BadRequestException);

      expect(ssgEventRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});