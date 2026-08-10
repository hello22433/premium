export type InventoryPinItemStatus = 'AVAILABLE' | 'ASSIGNED' | 'VOID';

export type InventoryPinImportBatchStatus = 'VALIDATING' | 'COMMITTED' | 'REJECTED';

export type InventoryPinEmailAttemptStatus = 'CLAIMED' | 'SENT' | 'FAILED' | 'UNKNOWN';

export type InventoryPinEmailAttemptType = 'INITIAL' | 'RESEND';

export type InventoryPinEmailOutboxState = 'PENDING' | 'CLAIMED' | 'PAUSED' | 'DONE' | 'VOID';

export type InventoryPinBillingChainState = 'DEBITED' | 'REFUNDED';

export type InventoryPinReissueStatus = 'COMPLETED';

export type DirectPinFulfillmentStatus =
  | 'PENDING_SEND'
  | 'SENDING'
  | 'SENT'
  | 'FAILED'
  | 'UNKNOWN'
  | 'VOID';

export type ExternalApiPinInventoryRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
