import { BadRequestException } from '@nestjs/common';

/**
 * persistAllocation 이 락 후 재계산 결과 credit_excess(신용초과) 가 발생했는데
 * 사전 승인(creditExcessApprovalId)이 없을 때 throw.
 *
 * BadRequestException 을 상속하므로 기존 내부 호출부의 catch 동작은 그대로 유지된다.
 * External API 처럼 승인 UI 가 없어 신용초과를 거절해야 하는 호출부는 이 타입만 catch 해
 * 자체 에러코드(예: 잔액부족)로 변환한다. (generic 문자열 매칭 대신 typed 계약)
 */
export class CreditExcessApprovalRequiredError extends BadRequestException {
  constructor(
    public readonly creditExcessAmount: number,
    public readonly orderId?: number,
  ) {
    super(`credit_excess_approval_required: creditExcessAmount=${creditExcessAmount} but no approvalId supplied`);
  }
}
