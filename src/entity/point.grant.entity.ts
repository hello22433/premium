import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('point_grant')
@Index('idx_point_grant_wallet_expire', ['walletAccountId', 'expiresAt'])
export class PointGrantEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint' })
  walletAccountId: string;

  @Column({ type: 'int', comment: '발급 시점 금액' })
  originalAmount: number;

  @Column({ type: 'int', comment: '잔여 금액' })
  remainingAmount: number;

  @Column({ type: 'datetime', nullable: true, comment: 'NULL = 만료 없음' })
  expiresAt: Date | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  reason: string | null;

  @Column({ type: 'tinyint', width: 1, default: 1 })
  active: number;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
