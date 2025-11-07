import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { format } from 'date-fns';

export const AlimTalkEncourageTemplate = (orderDelivery: OrderDeliveryEntity, templateCode: string) => {
  // 템플릿 코드에 'dev'가 포함되어 있으면 테스트 환경으로 판단
  const isTestTemplate = templateCode.toLowerCase().includes('dev');

  const barcodeLast4 = orderDelivery.barCode!.slice(-4);
  const expireDate = format(orderDelivery.expireAt!, 'yyyy.MM.dd');

  const message = `미사용쿠폰발생.
뒷자리 ${barcodeLast4}번.
${expireDate}일까지 사용.
재발송문의 1644-3614`;

  // 테스트 환경일 경우 [TEST] 접두사 추가
  if (isTestTemplate) {
    return `[TEST]
${message}`;
  }

  return message;
};
