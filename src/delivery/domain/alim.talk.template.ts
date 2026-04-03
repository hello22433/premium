import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { IOrderType } from '../../order/interface/order.type';
import dayjs from 'dayjs';

export const AlimTalkTemplate = (orderDelivery: OrderDeliveryEntity) => {
  const couponCode =
    orderDelivery.orderProductMapping.order.type === IOrderType.SSG
      ? orderDelivery.personalCode
      : orderDelivery.barCode;

  const order = orderDelivery.orderProductMapping.order;
  const product = orderDelivery.orderProductMapping.product;

  // 선택 완료된 초이스쿠폰이면 선택된 상품 정보 사용
  const displayProduct = orderDelivery.choiceSelectProduct ?? product;
  const displayBrand = (orderDelivery.choiceSelectProduct?.brand ?? product.brand)!;

  const brandKoreanName =
    displayBrand.nameKorean === '신세계' ? '이마트' : displayBrand.nameKorean;

  // 발행자: 대행주문인 경우 clientUser의 회사명, 아니면 주문자의 회사명
  const publisherName = order.clientUser?.company?.businessName ?? order.user!.company?.businessName ?? '';

  const sendTitle = orderDelivery.orderProductMapping.sendTitle ?? '';

  // 템플릿 코드에 'dev'가 포함되어 있으면 테스트 환경으로 판단
  const templateCode = process.env.ALIM_TALK_INFO_BANK_TEMPLATE_CODE || '';
  const isTestTemplate = templateCode.toLowerCase().includes('dev');

  // 유효기간: expireAt이 저장되어 있으면 그대로 사용 (재전송 시 재계산 방지)
  let expireDateStr: string;
  if (orderDelivery.expireAt) {
    expireDateStr = dayjs(orderDelivery.expireAt).format('YYYY. MM. DD');
  } else {
    const validityStartsNextDay = displayProduct.partnerCompany?.validityStartsNextDay ?? true;
    const expireDays = validityStartsNextDay ? displayProduct.expireDay : displayProduct.expireDay - 1;
    const baseDate = orderDelivery.actualSendAt ? dayjs(orderDelivery.actualSendAt) : dayjs();
    expireDateStr = baseDate.add(expireDays, 'day').format('YYYY. MM. DD');
  }

  // 테스트 환경일 경우 [TEST] 접두사와 테스트 메시지 추가
  if (isTestTemplate) {
    return `[TEST]
[모바일쿠폰] 이팝콘 도착
상품명 : ${displayProduct.name}
유효기간 : ~ ${expireDateStr}
쿠폰번호 : ${couponCode}
사용처(교환처) : ${brandKoreanName}
고객센터 : 1644-3614
발행자 : ${publisherName}

이 메시지는 알림톡 테스트 메시지 입니다.

${sendTitle} 당첨을 축하드립니다.
문의사항은 고객센터 번호를 통해 문의하시길 바랍니다.
이 메시지는 고객님의 동의에 의해 지급된 쿠폰 안내 메시지입니다.`;
  }

  return `[모바일쿠폰] 이팝콘 선물 도착
  
${sendTitle}

▶상품명 : ${displayProduct.name}
▶유효기간 : ~ ${expireDateStr}
▶쿠폰번호 : ${couponCode}
▶사용처(교환처) : ${brandKoreanName}
▶고객센터 : 1644-3614
▶발행자 : ${publisherName}

문의사항은 고객센터 번호를 통해 문의하시길 바랍니다.
이 메시지는 계약이나 거래관계로 인해 지급된 쿠폰 안내 메시지입니다.

하기 쿠폰 확인하기 버튼을 통해 상세내역 확인 바랍니다.`;
};
