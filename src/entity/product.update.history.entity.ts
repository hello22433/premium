import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { UserEntity } from './user.entity';

@Entity('product_update_history')
export class ProductUpdateHistoryEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: '변경한 user id' })
  userId: number;

  @Column({ comment: 'product.id' })
  productId: number;

  @Column({ type: 'varchar', length: 256, comment: '변경 key 값' })
  key: string;

  @Column({ type: 'varchar', length: 256, comment: '변경 key 이름' })
  keyName: string;

  @Column({ type: 'varchar', length: 512, nullable: true, comment: '변경 전 value' })
  beforeValue: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true, comment: '변경 후 value' })
  afterValue: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true, comment: '수정 사유' })
  reason: string | null;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;
}
