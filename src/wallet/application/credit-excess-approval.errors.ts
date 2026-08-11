import { BadRequestException } from '@nestjs/common';
import { CreditExcessApprovalEntity } from '../../entity/credit.excess.approval.entity';

/**
 * 발송확정 트랜잭션에서 승인 스냅샷과 재계산 결과가 어긋났을 때 throw.
 * 승인 orchestration 은 이 오류를 RE_REQUEST_REQUIRED(재요청 필요) 로 분류한다.
 */
export class CreditExcessApprovalDriftError extends BadRequestException {
  constructor(
    readonly changedFields: string[],
    readonly internalReason: string,
  ) {
    super(`credit excess approval drift: ${internalReason}`);
  }
}

/**
 * PENDING → PROCESSING CAS 선점이 동시 요청에 밀려 실패했을 때 throw.
 * 이미 다른 승인 요청이 선점/종료시킨 상태이므로, orchestration 은 이 오류를 오류 응답이 아니라
 * **현재 상태 멱등 반환**으로 처리한다. `current` 는 선점 실패 직후 재조회한 최신 approval row.
 */
export class CreditExcessApprovalClaimConflictError extends Error {
  constructor(readonly current: CreditExcessApprovalEntity) {
    super(`credit excess approval claim conflict (status=${current.status})`);
  }
}
