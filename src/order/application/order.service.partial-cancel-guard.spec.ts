// ★ requireActual 스프레드 필수: import 그래프 내 다른 서비스가 Propagation 등 다른 export 를
//   클래스정의 시점에 쓰므로, 전체 모듈을 덮으면 로드가 깨진다. Transactional 만 override.
//   (기존 취소 스펙들과 동일한 패턴 — order.service.cancel-notification.spec.ts 참고)
jest.mock('typeorm-transactional', () => ({
  ...jest.requireActual('typeorm-transactional'),
  Transactional: () => () => undefined,
  runOnTransactionCommit: (cb: () => void) => cb(),
}));

import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';

/**
 * 부분취소 미구현 구간의 안전 가드.
 *
 * deliveryIds 는 DTO 와 Swagger 에 이미 노출돼 있지만 deliveryCancel 은 아직 주문 전체를 취소한다.
 * 이 값을 조용히 무시하면 "3건만 취소" 요청이 "주문 전체 취소 + 전액 환불" 로 실행되고 응답은 200 이다.
 * 요청보다 더 많이 하는 셈이라 실패보다 나쁘다 — 되돌릴 수 없고 응답만 봐서는 티도 안 난다.
 *
 * 이 스펙은 두 가지를 함께 지킨다.
 *  1) deliveryIds 를 보내면 거부한다 (조용한 확대 차단)
 *  2) 거부는 "요청을 건드리기 전" 에 일어난다 — DB 조회조차 하지 않아야 부분 처리 흔적이 안 남는다
 *
 * 부분취소 전환 커밋에서 이 가드가 제거되므로 이 스펙도 그때 함께 삭제/교체된다.
 */
describe('OrderService.deliveryCancel — 부분취소 미지원 가드', () => {
  const makeSut = () => {
    const createQueryBuilder = jest.fn(() => {
      throw new Error('가드보다 먼저 DB 를 조회하면 안 된다');
    });
    const sut: any = Object.create(OrderService.prototype);
    sut.orderRepository = { createQueryBuilder };
    return { sut, createQueryBuilder };
  };

  const base = { id: 1001, cancelReason: '고객 요청' };

  it('deliveryIds 를 보내면 400 으로 거부한다', async () => {
    const { sut } = makeSut();

    await expect(sut.deliveryCancel({ id: 1 }, { ...base, deliveryIds: [9003] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('거부 메시지가 "왜 거부됐고 어떻게 하면 되는지" 를 알려준다', async () => {
    const { sut } = makeSut();

    await expect(sut.deliveryCancel({ id: 1 }, { ...base, deliveryIds: [9003] })).rejects.toThrow(
      /아직 지원하지 않습니다/,
    );
  });

  it('거부는 DB 조회 이전에 일어난다 (부분 처리 흔적을 남기지 않는다)', async () => {
    const { sut, createQueryBuilder } = makeSut();

    await expect(sut.deliveryCancel({ id: 1 }, { ...base, deliveryIds: [9003] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });

  it('빈 배열도 거부한다 — DTO 를 우회해 서비스를 직접 부르는 경로 대비', async () => {
    const { sut, createQueryBuilder } = makeSut();

    // JS 에서 [] 는 truthy 이므로 if (deliveryIds) 가드가 그대로 발동한다.
    // 정상 경로에서는 DTO 의 @ArrayNotEmpty 가 먼저 400 을 내지만, 서비스를 직접 부르거나
    // 검증 파이프를 우회하는 경로가 생겨도 "빈 배열이 조용히 전체취소로 해석되는" 일은 없다.
    await expect(sut.deliveryCancel({ id: 1 }, { ...base, deliveryIds: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });

  it('deliveryIds 가 없으면 가드를 통과해 기존 경로로 진행한다', async () => {
    const { sut, createQueryBuilder } = makeSut();

    // 가드를 통과하면 곧바로 주문 조회로 진입하므로, mock 이 던지는 에러가 곧 "통과했다" 는 증거다.
    await expect(sut.deliveryCancel({ id: 1 }, base)).rejects.toThrow(/가드보다 먼저 DB 를 조회하면 안 된다/);
    expect(createQueryBuilder).toHaveBeenCalled();
  });
});
