import { BaseEntity } from '../common/entity/base.entity';
import { Column, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { UserEntity } from './user.entity';

@Entity('product_shared_list_file')
export class ProductSharedListFileEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('idx_product_shared_list_file_user_id')
  @Column({ comment: 'FK) user.id, 업로드한 관리자 id' })
  userId: number;

  @Column({ type: 'varchar', length: 255, comment: '원본 파일명' })
  fileName: string;

  @Column({ type: 'varchar', length: 500, comment: '업로드 파일 url' })
  fileUrl: string;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  user: UserEntity;
}
