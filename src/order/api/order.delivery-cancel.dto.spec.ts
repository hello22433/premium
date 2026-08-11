import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { OrderDeliveryCancelReqDto } from './order.req.dto';

/**
 * 발송취소 요청 DTO 의 deliveryIds 검증 계약 (197-16, ihwgm 리뷰 P1).
 *
 * 이 필드의 계약은 **"생략하면 주문 전체 취소"** 다. 그래서 "검증을 건너뛰는 조건" 이
 * 정확히 `undefined` 하나여야 한다.
 *
 * @IsOptional 을 쓰면 undefined **와 null 둘 다** 를 건너뛴다. 그러면 deliveryIds: null 이
 * 400 을 안 받고 통과해, 서비스의 갈림길(`deliveryIds && length > 0`)에서 falsy 로 떨어져
 * **주문 전체 취소 + 전액 환불** 이 실행된다. 빈 배열은 400 인데 null 은 전액 환불이라
 * 방향이 정반대다.
 *
 * 실제 앱과 같은 ValidationPipe(whitelist·transform)로 태워 검증한다 —
 * 데코레이터만 눈으로 보는 테스트는 파이프 설정이 다르면 거짓 초록이 된다.
 */
describe('OrderDeliveryCancelReqDto — deliveryIds 검증', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const meta = { type: 'body' as const, metatype: OrderDeliveryCancelReqDto };

  const validate = (body: Record<string, unknown>) => pipe.transform(body, meta);

  const base = { id: 700, cancelReason: '고객 요청' };

  describe('전체취소로 해석되는 입력', () => {
    it('필드를 생략하면 통과하고 deliveryIds 는 undefined 다', async () => {
      const dto = await validate({ ...base });

      expect(dto.deliveryIds).toBeUndefined();
    });
  });

  describe('거부해야 하는 입력', () => {
    it('★ null 은 400 이다 — 통과하면 주문 전체가 취소·환불된다', async () => {
      await expect(validate({ ...base, deliveryIds: null })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('빈 배열은 400 이다 (전체취소는 필드 생략으로 표현한다)', async () => {
      await expect(validate({ ...base, deliveryIds: [] })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('배열이 아니면 400 이다', async () => {
      await expect(validate({ ...base, deliveryIds: 9003 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('중복이 있으면 400 이다 (SQL IN 이 중복을 접어 가짜 경합이 된다)', async () => {
      await expect(validate({ ...base, deliveryIds: [9003, 9003] })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('0 이하 · 소수는 400 이다 (매칭 0건이 되어 같은 가짜 경합을 만든다)', async () => {
      await expect(validate({ ...base, deliveryIds: [0] })).rejects.toBeInstanceOf(BadRequestException);
      await expect(validate({ ...base, deliveryIds: [-1] })).rejects.toBeInstanceOf(BadRequestException);
      await expect(validate({ ...base, deliveryIds: [9003.7] })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('1000 개를 넘으면 400 이다', async () => {
      const tooMany = Array.from({ length: 1001 }, (_, i) => i + 1);

      await expect(validate({ ...base, deliveryIds: tooMany })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('정상 입력', () => {
    it('유효한 id 배열은 통과한다', async () => {
      const dto = await validate({ ...base, deliveryIds: [9003, 9004] });

      expect(dto.deliveryIds).toEqual([9003, 9004]);
    });
  });
});
