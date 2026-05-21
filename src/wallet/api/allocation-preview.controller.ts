import { Body, Controller, NotImplementedException, Post, UseGuards } from '@nestjs/common';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { AllocationPreviewReqDto } from './allocation-preview.req.dto';

export interface AllocationPreviewResponse {
  grossSettlementAmount: number;
  pointUsedAmount: number;
  cardSurchargeBase: number;
  cardSurchargeAmount: number;
  payableSettlementAmount: number;
  depositUsedAmount: number;
  creditUsedAmount: number;
  creditExcessAmount: number;
  policyDeniedLines: Array<{ orderProductMappingId: number; reason: string }>;
  needsApproval: boolean;
  approvalId?: string;
}

/**
 * 발송확정 dry-run preview.
 *  - DB 차감 없음. wallet_account / allocation / transaction 저장 안 함.
 *  - §3 락 사용 안 함. 발송확정 시점에 재확인.
 *  - 신용초과 케이스도 동일 endpoint 사용. needsApproval=true 응답.
 *
 * PR2b 본 구현은 order/delivery 라인 수집 + PaymentAllocationService.allocate() 호출 + 정책 평가.
 * PR2 스캐폴드: 인터페이스/엔드포인트 등록. order 통합은 PR2 본 작업 단계에서 완성.
 */
@Controller('order/delivery')
@UseGuards(AuthUserSuperAndOperationAdminGuard)
export class AllocationPreviewController {
  @Post('allocation-preview')
  async preview(@Body() _dto: AllocationPreviewReqDto): Promise<AllocationPreviewResponse> {
    throw new NotImplementedException(
      'PR2 진행 중: allocation-preview endpoint 는 order/delivery 라인 수집 통합 후 활성화. ' +
        'consensus plan §PR2 deliveryConfirmed 통합 단계에서 구현.',
    );
  }
}
