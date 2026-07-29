import { EXTERNAL_ORDER_DELIVERY_RELATIONS } from './external.api.service';

/**
 * 외부 API 재발송(`resendOrder`)은 `AlimTalkTemplate` 을 태운다. 템플릿이 참조하는 관계가 하나라도
 * 빠지면 템플릿에서 TypeError 가 나고, 호출부가 그것을 "알림톡 실패"로 오인해 알림톡을 시도조차
 * 못한 채 MMS 폴백으로 흘려보낸다(파트너는 ALIM_TALK 로 주문했는데 MMS 가 나감).
 *
 * 실제 사고: order.user 미로딩 → `order.user!.company` TypeError → 재발송 전건 MMS 폴백.
 */
describe('외부 API trId 조회 relation 계약', () => {
  const required = [
    // 발행자명: order.clientUser?.company ?? order.user?.company
    'orderProductMapping.order.user',
    'orderProductMapping.order.user.company',
    'orderProductMapping.order.clientUser',
    'orderProductMapping.order.clientUser.company',
    // 브랜드명: choiceSelectProduct?.brand ?? product.brand
    'orderProductMapping.product.brand',
    'choiceSelectProduct',
    'choiceSelectProduct.brand',
    // 유효기간: product.partnerCompany.validityStartsNextDay
    'orderProductMapping.product.partnerCompany',
  ];

  it.each(required)('AlimTalkTemplate 이 참조하는 %s 을 로딩한다', (relation) => {
    expect(EXTERNAL_ORDER_DELIVERY_RELATIONS).toContain(relation);
  });

  it('중첩 관계는 부모 관계도 함께 로딩한다(TypeORM 요구)', () => {
    for (const relation of EXTERNAL_ORDER_DELIVERY_RELATIONS) {
      const parts = relation.split('.');
      for (let i = 1; i < parts.length; i++) {
        expect(EXTERNAL_ORDER_DELIVERY_RELATIONS).toContain(parts.slice(0, i).join('.'));
      }
    }
  });
});
