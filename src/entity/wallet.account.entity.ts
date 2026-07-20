import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

export type WalletAccountOwnerType = 'SETTLEMENT_CODE';

@Entity('wallet_account')
@Unique('uq_wallet_owner', ['ownerType', 'ownerId'])
@Index('idx_wallet_account_owner_id', ['ownerId'])
@Index('idx_wallet_account_owner_company', ['ownerCompanyId', 'ownerType'])
export class WalletAccountEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 20, comment: 'SETTLEMENT_CODE 단일값' })
  ownerType: WalletAccountOwnerType;

  @Column({ type: 'varchar', length: 50, comment: 'user.settlement_code 값 (예: company-123)' })
  ownerId: string;

  @Column({
    name: 'owner_company_id',
    type: 'int',
    nullable: true,
    comment: 'SETTLEMENT_CODE 홈(발급) 회사 id. N:M 사용 회사와 별개, 비정산코드 owner는 NULL',
  })
  ownerCompanyId: number | null;

  @Column({ type: 'int', default: 0, comment: '예치금 잔액' })
  depositBalance: number;

  @Column({ type: 'int', default: 0, comment: '여신 한도' })
  creditLimit: number;

  @Column({ type: 'int', default: 0, comment: '여신 사용액' })
  creditUsedAmount: number;

  @Column({ type: 'int', default: 0, comment: '신용초과 사용액' })
  creditExcessAmount: number;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'POST_PAYMENT',
    comment: 'PRE_PAYMENT(선정산) / POST_PAYMENT(후정산). settlement_code 단위 정책.',
  })
  settleCondition: 'PRE_PAYMENT' | 'POST_PAYMENT';

  @Column({
    type: 'varchar',
    length: 20,
    default: 'CASH',
    comment: 'CARD / CASH. settlement_code 단위 정책.',
  })
  settleMethod: 'CARD' | 'CASH';

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
