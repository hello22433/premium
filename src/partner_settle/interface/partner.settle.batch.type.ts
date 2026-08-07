export type IPartnerSettleBatchStatus = 'CONFIRMED_UNPAID' | 'PAID' | 'CANCELED';

export type IPartnerSettleBatchType = 'NORMAL' | 'OPENING_IMPORT';

export type IPartnerSettleExclusionAction = 'SKIP_ONCE' | 'HOLD' | 'HOLD_RELEASE';

export type IPartnerSettleConfigSource = 'OPENING_IMPORT' | 'CUTOVER_MANUAL';

export type IPartnerSettleCancelReconStatus = 'ACTIVE' | 'INACTIVE' | 'TERMINATED' | 'PERMANENT_FAIL';

export type IPartnerSettlePaymentRequestStatus = 'PENDING_VARIANCE' | 'PAID' | 'REJECTED';

export type IPartnerSettlePaymentVarianceProposalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
