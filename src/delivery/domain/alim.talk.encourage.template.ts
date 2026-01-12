import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { format } from 'date-fns';

export const AlimTalkEncourageTemplate = (orderDelivery: OrderDeliveryEntity, templateCode: string) => {
  // 템플릿 코드에 'dev'가 포함되어 있으면 테스트 환경으로 판단
  const isTestTemplate = templateCode.toLowerCase().includes('dev');

  const expireDate = format(orderDelivery.expireAt!, 'yyyy.MM.dd');

  const message = `쿠폰 소멸(유효기간) 안내

안녕하세요. 모바일이앤엠애드입니다.
고객님께서 보유하신 쿠폰의 유효기간 만료일을 안내드립니다.
유효기간: ${expireDate}
유효기간 만료 시: 사용/재발송/기간연장/환불 불가

※ 이 메시지는 고객님이 참여한 이벤트 당첨으로 지급된 쿠폰 안내 메시지입니다.
※ 쿠폰 관련 문의: 1644-3614(내선 1번)`;

  // 테스트 환경일 경우 [TEST] 접두사 추가
  if (isTestTemplate) {
    return `[TEST]
${message}`;
  }

  return message;
};
