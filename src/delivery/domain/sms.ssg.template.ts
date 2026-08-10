import { format } from 'date-fns';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { ssgIssueUserName } from '../../const';

/**
 * 금액을 한글 단위로 변환 (예: 5000 → "5천", 100000 → "10만", 2155000 → "215만5천")
 */
export function formatAmountKorean(amount: number): string {
  const man = Math.floor(amount / 10000);
  const cheon = Math.floor((amount % 10000) / 1000);

  let result = '';
  if (man > 0) result += `${man}만`;
  if (cheon > 0) result += `${cheon}천`;

  return result || '0';
}

/**
 * SSG 상품명에서 금액을 추출하여 한글로 변환
 * "신세계 상품권 2,155,000원" → "215만5천"
 */
const SSG_AMOUNT_REGEX = /([\d,]+)원/;

function extractSsgAmountKorean(productName: string): string {
  const match = productName.match(SSG_AMOUNT_REGEX);
  if (!match) return '0';
  const amount = parseInt(match[1].replace(/,/g, ''), 10);
  return formatAmountKorean(amount);
}

/**
 * SSG SMS 전용 짧은 템플릿 (90byte 이내)
 * 예: "신세계5천원\n쿠폰번호:01300000000\n인증번호:00000000\n26/12/31까지"
 */
export const smsSsgShortTemplate = (orderDelivery: OrderDeliveryEntity) => {
  const amountKorean = extractSsgAmountKorean(orderDelivery.orderProductMapping.product.name);
  return `신세계${amountKorean}원\n쿠폰번호:${orderDelivery.personalCode}\n인증번호:${orderDelivery.barCode}\n${format(orderDelivery.expireAt!, 'yy/MM/dd')}까지`;
};

export const smsSsgTemplate = (orderDelivery: OrderDeliveryEntity) => {
  return `
  
  본 교환권은 지류상품권으로 교환 후 사용할 수 있는 교환권입니다(SSG닷컴, SSG페이 사용불가)

▷상 품 명: ${orderDelivery.orderProductMapping.product.name}
▷쿠폰번호: ${orderDelivery.personalCode}
▷인증번호: ${orderDelivery.barCode}
▷발송업체: ${ssgIssueUserName}
▷교환기간: ${format(orderDelivery.expireAt!, 'yyyy-MM-dd')} 까지
▷사용처(교환처): 이마트
 가까운 신세계이마트 위치 검색하기: https://www.epopkon.com/ssg/how2use

▷교환방법: 고객센터에 비치된
 키오스크에 쿠폰번호 인증번호 입력
 키오스크 이용방법: https://www.epopkon.com/ssg/kiosk

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
▷ 신세계 모바일교환권/상품권 유의사항: https://www.epopkon.com/ssg/notice
`;
};
