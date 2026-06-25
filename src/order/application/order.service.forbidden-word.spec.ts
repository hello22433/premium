import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';

/**
 * 금칙어 차단 회귀 테스트.
 *
 * 1) 임시저장 검사(assertNoForbiddenWord)가 sendTitle(전송 제목)도 검사한다.
 * 2) 발송요청 직전 게이트(assertNoForbiddenWordInOrder)가 저장된 주문 엔티티의
 *    sendTitle/sendContent/대치문자까지 재검사한다.
 * 3) 적발 시 block_log 기록 후 BadRequestException(FORBIDDEN_WORD) throw.
 */
describe('OrderService 금칙어 차단', () => {
  const user = { id: 1, email: 'owner@example.com', authority: 'USER' } as any;

  const createService = (forbiddenWords: string[]) => {
    const service = Object.create(OrderService.prototype) as any;
    service.forbiddenWordMatcher = {
      scan: (text: string | null | undefined) => {
        const normalized = (text ?? '').replace(/\s+/g, '').toLowerCase();
        return forbiddenWords.filter((w) => normalized.includes(w));
      },
    };
    service.forbiddenWordBlockLogRepository = { insert: jest.fn().mockResolvedValue(undefined) };
    return service;
  };

  describe('assertNoForbiddenWord (임시저장)', () => {
    it('sendTitle(전송 제목)의 금칙어를 차단한다', async () => {
      const service = createService(['도박']);

      await expect(
        service.assertNoForbiddenWord(
          user,
          [{ sendTitle: '도박 이벤트', sendContent: '정상 내용', orderDeliveryList: [] }],
          null,
        ),
      ).rejects.toMatchObject({ response: { code: 'FORBIDDEN_WORD', words: ['도박'] } });

      expect(service.forbiddenWordBlockLogRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ field: 'sendTitle', matchedWords: ['도박'] }),
      );
    });

    it('sendContent(전송 내용)의 금칙어를 차단한다', async () => {
      const service = createService(['대출']);

      await expect(
        service.assertNoForbiddenWord(
          user,
          [{ sendTitle: '정상 제목', sendContent: '저금리 대출 안내', orderDeliveryList: [] }],
          null,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('금칙어가 없으면 통과한다', async () => {
      const service = createService(['도박']);

      await expect(
        service.assertNoForbiddenWord(
          user,
          [{ sendTitle: '정상 제목', sendContent: '정상 내용', orderDeliveryList: [] }],
          null,
        ),
      ).resolves.toBeUndefined();
      expect(service.forbiddenWordBlockLogRepository.insert).not.toHaveBeenCalled();
    });
  });

  describe('assertNoForbiddenWordInOrder (발송요청 직전)', () => {
    it('저장된 주문의 sendTitle 금칙어를 발송요청 단계에서 차단한다', async () => {
      const service = createService(['도박']);

      const order = {
        id: 42,
        orderProductMappings: [
          {
            sendTitle: '도박 사이트 오픈',
            sendContent: '정상 내용',
            orderDeliveries: [{ replaceCharacter1: '정상' }],
          },
        ],
      };

      await expect(service.assertNoForbiddenWordInOrder(user, order)).rejects.toMatchObject({
        response: { code: 'FORBIDDEN_WORD' },
      });
      expect(service.forbiddenWordBlockLogRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ field: 'sendTitle', orderId: 42 }),
      );
    });

    it('저장된 주문의 대치문자 금칙어도 차단한다', async () => {
      const service = createService(['욕설']);

      const order = {
        id: 7,
        orderProductMappings: [
          {
            sendTitle: '정상',
            sendContent: '정상',
            orderDeliveries: [{ replaceCharacter2: '욕설 포함' }],
          },
        ],
      };

      await expect(service.assertNoForbiddenWordInOrder(user, order)).rejects.toBeInstanceOf(BadRequestException);
      expect(service.forbiddenWordBlockLogRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ field: 'replaceCharacter2' }),
      );
    });

    it('금칙어가 없으면 발송요청을 통과한다', async () => {
      const service = createService(['도박']);

      const order = {
        id: 9,
        orderProductMappings: [
          { sendTitle: '정상', sendContent: '정상', orderDeliveries: [{ replaceCharacter1: '정상' }] },
        ],
      };

      await expect(service.assertNoForbiddenWordInOrder(user, order)).resolves.toBeUndefined();
    });
  });
});
