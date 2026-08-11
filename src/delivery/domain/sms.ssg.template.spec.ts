import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { smsSsgTemplate } from './sms.ssg.template';

describe('smsSsgTemplate', () => {
  it('신세계 발송 문구를 승인된 순서와 표현으로 생성한다', () => {
    const orderDelivery = {
      personalCode: '99999',
      barCode: '88888',
      expireAt: new Date(2026, 11, 31),
      orderProductMapping: {
        product: { name: '신세계 모바일 교환권 10,000원' },
      },
    } as OrderDeliveryEntity;

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
});
