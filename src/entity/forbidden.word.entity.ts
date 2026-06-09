import { BaseEntity } from '../common/entity/base.entity';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('forbidden_word')
export class ForbiddenWordEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 100, unique: true, comment: '금칙어 (완전일치 대상)' })
  word: string;

  @Column({ type: 'varchar', length: 50, nullable: true, comment: '분류 (욕설/성적/대출/도박/유흥 등)' })
  category: string | null;

  @Column({ type: 'tinyint', width: 1, default: 1, comment: '활성 여부 (1: 활성, 0: 비활성)' })
  isActive: number;
}
