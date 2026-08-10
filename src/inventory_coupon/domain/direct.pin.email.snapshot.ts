/**
 * 주문 시점 직접 PIN 이메일 발송에 필요한 설정 스냅샷.
 * order_product_mapping.direct_pin_email_snapshot JSON 컬럼에 저장한다.
 * 한 번 assignment가 생기면 불변이다.
 */
export interface DirectPinEmailSnapshotV1 {
  version: 1;
  productConfigVersion: number;
  codeSchemaVersion: number;
  faceValueAmount: string;
  currencyCode: string;
  primaryCodeLabel: string;
  secondaryCodeLabel: string | null;
  howToUse: string;
  notice: string;
  validityDays: number;
  validityStartsNextDay: boolean;
  locale: 'en';
}

export type DirectPinEmailSnapshot = DirectPinEmailSnapshotV1;
