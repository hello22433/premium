import { CreditExcessSnapshot } from './credit-excess-snapshot';

/**
 * 신용초과 승인 실행 컨텍스트.
 *
 * 승인자(운영관리자)와 요청자(기업관리자)를 분리해 전달한다. 발송확정 command 는 요청자 권한으로
 * 실행되고, 활동 로그에는 승인자·요청자·서버 실행 출처가 함께 남는다.
 */
export interface CreditExcessApprovalExecutionContext {
  approvalId: string;
  attemptToken: string;
  snapshot: CreditExcessSnapshot;
  requesterUserId: number;
  approverUserId: number;
  approverEmail: string;
  ipAddress: string;
}
