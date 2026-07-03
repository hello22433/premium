import { BadRequestException } from '@nestjs/common';

/**
 * deliveryRequest(발송요청) 시 WALLET 흐름(order.isNewBillingFlow=true)인데
 * 과금 대상 user 의 settlement_code 가 비어있을 때 throw.
 *
 * BadRequestException 을 상속하되 OBJECT payload 를 넘겨 response body 에 code 가
 * 직렬화되도록 한다. FE 는 response.data.code === 'SETTLEMENT_CODE_REQUIRED' 로 분기해
 * 정산코드 지정/발급 안내를 노출한다. (generic 문자열 매칭 대신 typed 계약)
 */
export class SettlementCodeRequiredError extends BadRequestException {
  constructor() {
    super({ message: '정산코드 지정 또는 발급 필요', code: 'SETTLEMENT_CODE_REQUIRED' });
  }
}
