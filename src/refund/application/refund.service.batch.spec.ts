import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { RefundService } from './refund.service';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderDeliveryRefundStatusEnum } from '../../delivery/interface/order.delivery.refund.status.enum';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';

describe('RefundService 일괄(batch)', () => {
  let service: RefundService;
  let repo: jest.Mocked<Pick<Repository<OrderDeliveryEntity>, 'find' | 'save'>>;

  beforeEach(() => {
    repo = {
      find: jest.fn(),
      save: jest.fn(),
    };
    service = new RefundService(
      {} as CryptoCipher,
      {} as ActivityLogService,
      repo as unknown as Repository<OrderDeliveryEntity>,
    );
  });

  const progressRow = (id: number): OrderDeliveryEntity =>
    ({
      id,
      refundStatus: OrderDeliveryRefundStatusEnum.PROGRESS,
      bankAccountOwner: '홍길동',
      bankName: '국민',
      bankAccount: '123-456',
      approveAt: new Date('2026-05-01'),
      refundAt: new Date('2026-05-02'),
    }) as OrderDeliveryEntity;

  describe('resetBatch', () => {
    it('존재하지 않는 id가 하나라도 있으면 400을 던지고 save하지 않는다', async () => {
      repo.find.mockResolvedValue([progressRow(1)]); // 2는 없음

      await expect(service.resetBatch({ ids: [1, 2] })).rejects.toThrow(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('PROGRESS가 아닌 행이 하나라도 있으면 400을 던지고 save하지 않는다', async () => {
      repo.find.mockResolvedValue([
        progressRow(1),
        { id: 2, refundStatus: OrderDeliveryRefundStatusEnum.APPROVE } as OrderDeliveryEntity,
      ]);

      await expect(service.resetBatch({ ids: [1, 2] })).rejects.toThrow('진행중 상태의 환불만 초기화할 수 있습니다.');
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('모두 PROGRESS면 각 행의 5개 필드를 null로 비우고 refundStatus는 유지한 채 한 번에 save한다', async () => {
      const rows = [progressRow(1), progressRow(2)];
      repo.find.mockResolvedValue(rows);
      repo.save.mockResolvedValue(rows as unknown as OrderDeliveryEntity);

      await service.resetBatch({ ids: [1, 2] });

      expect(repo.save).toHaveBeenCalledTimes(1);
      const saved = repo.save.mock.calls[0][0] as OrderDeliveryEntity[];
      expect(saved).toHaveLength(2);
      for (const row of saved) {
        expect(row.bankAccountOwner).toBeNull();
        expect(row.bankName).toBeNull();
        expect(row.bankAccount).toBeNull();
        expect(row.approveAt).toBeNull();
        expect(row.refundAt).toBeNull();
        expect(row.refundStatus).toBe(OrderDeliveryRefundStatusEnum.PROGRESS);
      }
    });

    it('중복 id는 1건으로 정규화해 처리한다', async () => {
      const rows = [progressRow(1)];
      repo.find.mockResolvedValue(rows);
      repo.save.mockResolvedValue(rows as unknown as OrderDeliveryEntity);

      await service.resetBatch({ ids: [1, 1] });

      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(repo.save.mock.calls[0][0]).toHaveLength(1);
    });
  });

  describe('updateBatch', () => {
    const updateItem = (id: number) => ({
      id,
      refundStatus: OrderDeliveryRefundStatusEnum.APPROVE,
      bankAccountOwner: '홍길동',
      bankName: '국민',
      bankAccount: '123-456',
      approveAt: '2026-05-01',
    });

    it('items에 중복 id가 있으면 400을 던지고 조회/save하지 않는다', async () => {
      await expect(
        service.updateBatch({ items: [updateItem(1), updateItem(1)] }),
      ).rejects.toThrow('중복된 주문 id가 있습니다.');
      expect(repo.find).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('존재하지 않는 id가 있으면 400을 던지고 save하지 않는다', async () => {
      repo.find.mockResolvedValue([progressRow(1)]); // 2는 없음

      await expect(
        service.updateBatch({ items: [updateItem(1), updateItem(2)] }),
      ).rejects.toThrow('주문이 존재하지 않습니다');
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('한 항목이라도 승인 필수값 누락이면 400을 던지고 아무것도 save하지 않는다', async () => {
      repo.find.mockResolvedValue([progressRow(1), progressRow(2)]);

      const bad = { ...updateItem(2), bankAccount: '' }; // 승인인데 계좌 누락
      await expect(
        service.updateBatch({ items: [updateItem(1), bad] }),
      ).rejects.toThrow('승인 시 예금주, 은행명, 계좌번호를 입력해주세요.');
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('모두 유효하면 각 항목을 반영해 한 번에 save한다', async () => {
      const rows = [progressRow(1), progressRow(2)];
      repo.find.mockResolvedValue(rows);
      repo.save.mockResolvedValue(rows as unknown as OrderDeliveryEntity);

      await service.updateBatch({ items: [updateItem(1), updateItem(2)] });

      expect(repo.save).toHaveBeenCalledTimes(1);
      const saved = repo.save.mock.calls[0][0] as OrderDeliveryEntity[];
      expect(saved).toHaveLength(2);
      for (const row of saved) {
        expect(row.refundStatus).toBe(OrderDeliveryRefundStatusEnum.APPROVE);
        expect(row.bankAccount).toBe('123-456');
      }
    });
  });
});
