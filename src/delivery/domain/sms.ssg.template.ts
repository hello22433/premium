import { format } from 'date-fns';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { ssgIssueUserName } from '../../const';

export const smsSsgTemplate = (orderDelivery: OrderDeliveryEntity) => {
  return `
  
  본 교환권은 지류상품권으로 교환 후 사용할 수 있는 교환권입니다(SSG닷컴, SSG페이 사용불가)

▷상 품 명: ${orderDelivery.orderProductMapping.product.name}
▷쿠폰번호: ${orderDelivery.personalCode}
▷인증번호: ${orderDelivery.barCode}
▷발송업체: ${ssgIssueUserName}
▷교환기간: ${format(orderDelivery.expireAt!, 'yyyy-MM-dd')} 까지
▷교 환 처: 전국 이마트 키오스크
 가까운 신세계이마트 위치 검색하기: http://m.enmad.com

▷교환방법: 고객센터에 비치된
 키오스크에 쿠폰번호 인증번호 입력
 키오스크 이용방법: http://m.enmad.com/kiosk.htm

▷ 유의사항
- 4만원 이하 권종은 1만원으로 분할하여 출력되니, 꼭 수량 확인 부탁드립니다.
- 교환처의 휴무일 사전 확인 후 유효기간내 교환부탁드립니다.
- 본 모바일교환권은 이벤트 및 프로모션으로 무상으로 지급되어 유효기간 연장 환불이 불가능합니다.
- 본 모바일 교환권은 개인간 양도 및 매매를 할 수 없으며, 이로 인한 문제 발생시 당사는 책임지지 않습니다.
- 수집된 전화번호는 개인정보보호를 위해 발송일로부터 6개월간 보유되며, 보유기간 이후에는 복구 불가능하게 삭제되어 CS처리가 불가능합니다.
- 인당 1일 쿠폰번호 10개까지 사용가능 합니다.

▷ 상품문의: 1644-3614(내선1번)
▷ 고객센터 운영시간: 평일 9시~18시
 (점심시간 12시~13시 / 토, 일, 공휴일 휴무)
▷ 신세계 상품권 사용처: http://m.enmad.com/private.htm
`;
};
