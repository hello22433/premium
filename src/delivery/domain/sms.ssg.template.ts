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

/**
 * SSG 안내문구의 폴백. 정본은 `product.memo`(DB) 이고, 이 상수는 memo 가 비어 있을 때만 쓰인다.
 *
 * 문자와 알림톡·이메일 쿠폰 페이지가 같은 문구를 써야 하는데, 쿠폰 페이지는 예전부터 memo 를
 * 그대로 노출해 왔다. 문자만 상수를 쓰면 문구 개정 때마다 두 경로가 갈라지므로 문자도 memo 를
 * 정본으로 읽는다. 문구 개정은 migration/ssg-product-memo-notice-sync.sql 로 DB 를 갱신한다.
 * (이 상수는 그 SQL 이 넣는 문구와 같은 내용이어야 한다 — 신규 환경/미백필 행의 안전망.)
 */
export const SSG_NOTICE_FALLBACK = `본 교환권은 지류상품권으로 교환 후 사용할 수 있는 교환권입니다(SSG닷컴, SSG페이 사용불가)

▷교환처: 전국 이마트 키오스크
▷가까운 이마트 위치 검색하기: https://www.epopkon.com/ssg/how2use

▷교환방법: 고객센터에 비치된 키오스크에 쿠폰번호, 인증번호 입력
▷키오스크 이용방법: https://www.epopkon.com/ssg/kiosk

▷유의사항
- 4만원 이하 권종은 1만원으로 분할하여 출력되니, 꼭 수량 확인 부탁드립니다.
- 교환처의 휴무일 사전 확인 후 유효기간내 교환부탁드립니다.
- 본 모바일 교환권은 이벤트 및 프로모션으로 무상으로 지급되어 유효기간 연장 환불이 불가능합니다.
- 본 모바일 교환권은 개인간 양도 및 매매를 할 수 없으며, 이로 인한 문제 발생시 당사는 책임지지 않습니다.
- 수집된 전화번호는 개인정보보호를 위해 발송일로부터 6개월간 보유되며, 보유기간 이후에는 복구 불가능하게 삭제되어 CS처리가 불가능합니다.
- 인당 1일 쿠폰번호 10개까지 사용가능 합니다.
- 신세계 모바일교환권/상품권 더 알아보기: https://www.epopkon.com/ssg/notice

▷발송처: ${ssgIssueUserName}
▷상품문의: 1644-3614 (내선 1번)
▷고객센터 운영시간: 평일 9시~18시
(점심시간 12시~13시 / 토, 일, 공휴일 휴무)`;

/**
 * 안내문구를 도입문장(첫 문단)과 나머지로 쪼갠다.
 *
 * 문자는 도입문장 바로 뒤에 발송건별 정보(상품명·쿠폰번호·인증번호·교환기간)를 끼워 넣어야
 * 종전과 같은 배치가 된다. 빈 줄이 없으면 쪼개지 않고 전부 뒤쪽으로 보낸다(배치만 달라질 뿐
 * 문구 누락은 없다).
 *
 * memo 는 운영자가 textarea 에 붙여넣는 값이라 줄바꿈이 CRLF/CR 일 수 있고, "빈 줄"에 공백·탭이
 * 섞일 수 있다. 둘 다 문단 구분자로 인정해야 도입문장 배치가 깨지지 않는다.
 */
const SSG_NOTICE_PARAGRAPH_BREAK = /\n[ \t]*\n/;

function splitSsgNotice(notice: string): { intro: string; rest: string } {
  const normalized = notice.replace(/\r\n?/g, '\n').trim();
  const separator = SSG_NOTICE_PARAGRAPH_BREAK.exec(normalized);

  if (!separator) {
    return { intro: '', rest: normalized };
  }

  return {
    intro: normalized.slice(0, separator.index),
    rest: normalized.slice(separator.index + separator[0].length),
  };
}

export const smsSsgTemplate = (orderDelivery: OrderDeliveryEntity) => {
  const memo = orderDelivery.orderProductMapping.product.memo?.trim();
  const { intro, rest } = splitSsgNotice(memo || SSG_NOTICE_FALLBACK);

  return `

${intro ? `${intro}\n\n` : ''}▷상품명: ${orderDelivery.orderProductMapping.product.name}
▷쿠폰번호: ${orderDelivery.personalCode}
▷인증번호: ${orderDelivery.barCode}
▷교환기간: ${format(orderDelivery.expireAt!, 'yyyy-MM-dd')} 까지
${rest}
`;
};
