import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { WalletResourceType } from '../wallet/interface/wallet-resource-type';

@Entity('wallet_transaction')
@Unique('uq_wallet_tx_idempotency', ['idempotencyKey'])
@Index('idx_wallet_tx_order', ['orderId'])
@Index('idx_wallet_tx_delivery', ['orderDeliveryId'])
@Index('idx_wallet_tx_account', ['walletAccountId'])
export class WalletTransactionEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint' })
  walletAccountId: string;

  @Column({ type: 'int', nullable: true })
  orderId: number | null;

  @Column({ type: 'int', nullable: true })
  orderDeliveryId: number | null;

  @Column({
    type: 'varchar',
    length: 40,
    comment: 'CONFIRM | CANCEL | FAIL_REFUND | DISCARD_REFUND | RESEND_DEDUCT | SETTLE_RELEASE | SETTLE_UNDO | GRANT',
  })
  type: string;

  @Column({ type: 'varchar', length: 20, comment: 'DEPOSIT | CREDIT | CREDIT_EXCESS | POINT' })
  resourceType: WalletResourceType;

  @Column({ type: 'int', comment: '차감은 음수, 적립/복구는 양수' })
  amount: number;

  @Column({ type: 'int', nullable: true, comment: '해당 resource_type 잔액 갱신 후 값' })
  balanceAfter: number | null;

  @Column({ type: 'int', nullable: true, comment: '해당 resource_type 잔액 갱신 전 값(감사 정본)' })
  balanceBefore: number | null;

  @Column({ type: 'int', nullable: true, comment: '운영자 수동 거래(예치금 충전 등) 실행 운영자 user.id — 감사 정본' })
  operatorId: number | null;

  @Column({ type: 'varchar', length: 190, nullable: true, comment: '운영자 수동 거래 실행 당시 운영자 email — 감사 정본' })
  operatorEmail: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  memo: string | null;

  @Column({
    type: 'varchar',
    length: 120,
    comment: '{event}:{orderId}:{deliveryId?}:{resource}:{cycle?}',
  })
  idempotencyKey: string;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}
