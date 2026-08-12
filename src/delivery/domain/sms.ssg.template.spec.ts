import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { smsSsgTemplate, SSG_NOTICE_FALLBACK } from './sms.ssg.template';

function buildOrderDelivery(memo?: string | null): OrderDeliveryEntity {
  return {
    personalCode: '99999',
    barCode: '88888',
    expireAt: new Date(2026, 11, 31),
    orderProductMapping: {
      product: { name: '신세계 모바일 교환권 10,000원', memo },
    },
  } as OrderDeliveryEntity;
}

describe('smsSsgTemplate', () => {
  it('memo 가 비면 폴백 상수로 승인된 순서와 표현을 유지한다', () => {
    const orderDelivery = buildOrderDelivery(null);

    expect(smsSsgTemplate(orderDelivery)).toBe(`

본 교환권은 지류상품권으로 교환 후 사용할 수 있는 교환권입니다(SSG닷컴, SSG페이 사용불가)

▷상품명: 신세계 모바일 교환권 10,000원
▷쿠폰번호: 99999
▷인증번호: 88888
▷교환기간: 2026-12-31 까지
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

▷발송처: 모바일이앤엠애드
▷상품문의: 1644-3614 (내선 1번)
▷고객센터 운영시간: 평일 9시~18시
(점심시간 12시~13시 / 토, 일, 공휴일 휴무)
`);
  });

  it('product.memo 가 있으면 그 문구를 정본으로 쓰고, 도입문장 뒤에 발송건별 정보를 끼워 넣는다', () => {
    const orderDelivery = buildOrderDelivery('도입문장입니다\n\n▷교환처: 개정된 교환처\n▷유의사항\n- 개정된 유의사항');

    expect(smsSsgTemplate(orderDelivery)).toBe(`

도입문장입니다

▷상품명: 신세계 모바일 교환권 10,000원
▷쿠폰번호: 99999
▷인증번호: 88888
▷교환기간: 2026-12-31 까지
▷교환처: 개정된 교환처
▷유의사항
- 개정된 유의사항
`);
  });

  it('memo 에 빈 줄이 없으면 발송건별 정보를 앞에 두고 문구 전체를 뒤에 붙인다', () => {
    const orderDelivery = buildOrderDelivery('빈 줄 없는 안내문구');

    expect(smsSsgTemplate(orderDelivery)).toBe(`

▷상품명: 신세계 모바일 교환권 10,000원
▷쿠폰번호: 99999
▷인증번호: 88888
▷교환기간: 2026-12-31 까지
빈 줄 없는 안내문구
`);
  });

  it('빈 줄에 공백·탭이 섞여 있어도 도입문장을 분리한다', () => {
    const orderDelivery = buildOrderDelivery('도입문장입니다\n \t \n▷교환처: 개정된 교환처');

    expect(smsSsgTemplate(orderDelivery)).toBe(`

도입문장입니다

▷상품명: 신세계 모바일 교환권 10,000원
▷쿠폰번호: 99999
▷인증번호: 88888
▷교환기간: 2026-12-31 까지
▷교환처: 개정된 교환처
`);
  });

  it('CRLF·단독 CR 줄바꿈을 정규화해 LF 입력과 같은 결과를 낸다', () => {
    const lf = smsSsgTemplate(buildOrderDelivery('도입문장입니다\n\n▷교환처: 개정된 교환처'));

    expect(smsSsgTemplate(buildOrderDelivery('도입문장입니다\r\n\r\n▷교환처: 개정된 교환처'))).toBe(lf);
    expect(smsSsgTemplate(buildOrderDelivery('도입문장입니다\r\r▷교환처: 개정된 교환처'))).toBe(lf);
  });

  it('공백만 있는 memo 는 폴백과 같은 결과를 낸다', () => {
    expect(smsSsgTemplate(buildOrderDelivery('   \n  '))).toBe(smsSsgTemplate(buildOrderDelivery(null)));
  });

  it('폴백 상수는 백필 SQL 과 같은 도입문장·빈 줄 구조를 갖는다', () => {
    expect(SSG_NOTICE_FALLBACK.startsWith('본 교환권은 지류상품권으로')).toBe(true);
    expect(SSG_NOTICE_FALLBACK.indexOf('\n\n')).toBeGreaterThan(0);
  });
});
