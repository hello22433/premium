import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { RefundService } from './refund.service';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderDeliveryRefundStatusEnum } from '../../delivery/interface/order.delivery.refund.status.enum';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';

describe('RefundService.reset', () => {
  let service: RefundService;
  let repo: jest.Mocked<Pick<Repository<OrderDeliveryEntity>, 'findOne' | 'save'>>;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      save: jest.fn(),
    };
    service = new RefundService(
      {} as CryptoCipher,
      {} as ActivityLogService,
      repo as unknown as Repository<OrderDeliveryEntity>,
    );
  });

  it('존재하지 않는 주문이면 400을 던지고 save하지 않는다', async () => {
    repo.findOne.mockResolvedValue(null);

    await expect(service.reset({ id: 999 })).rejects.toThrow(BadRequestException);
    await expect(service.reset({ id: 999 })).rejects.toThrow('주문이 존재하지 않습니다.');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('PROGRESS 상태가 아니면 400을 던지고 save하지 않는다', async () => {
    repo.findOne.mockResolvedValue({
      id: 1,
      refundStatus: OrderDeliveryRefundStatusEnum.APPROVE,
    } as OrderDeliveryEntity);

    await expect(service.reset({ id: 1 })).rejects.toThrow('진행중 상태의 환불만 초기화할 수 있습니다.');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('PROGRESS 행이면 5개 필드를 null로 비우고 refundStatus는 유지한 채 save한다', async () => {
    const order = {
      id: 1,
      refundStatus: OrderDeliveryRefundStatusEnum.PROGRESS,
      bankAccountOwner: '홍길동',
      bankName: '국민',
      bankAccount: '123-456',
      approveAt: new Date('2026-05-01'),
      refundAt: new Date('2026-05-02'),
    } as OrderDeliveryEntity;
    repo.findOne.mockResolvedValue(order);
    repo.save.mockResolvedValue(order);

    await service.reset({ id: 1 });

    expect(repo.save).toHaveBeenCalledTimes(1);
    const saved = repo.save.mock.calls[0][0] as OrderDeliveryEntity;
    expect(saved.bankAccountOwner).toBeNull();
    expect(saved.bankName).toBeNull();
    expect(saved.bankAccount).toBeNull();
    expect(saved.approveAt).toBeNull();
    expect(saved.refundAt).toBeNull();
    // refundStatus는 변경하지 않는다 (PROGRESS 유지)
    expect(saved.refundStatus).toBe(OrderDeliveryRefundStatusEnum.PROGRESS);
  });
});
