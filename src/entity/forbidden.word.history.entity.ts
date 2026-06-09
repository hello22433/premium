import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { ForbiddenWordAction } from '../forbidden_word/interface/forbidden.word.action';

@Entity('forbidden_word_history')
export class ForbiddenWordHistoryEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 100, comment: '대상 단어 (스냅샷, 삭제 후에도 이력 보존)' })
  word: string;

  @Column({ type: 'varchar', length: 10, comment: '변경 종류 (ADD, UPDATE, DELETE)' })
  action: ForbiddenWordAction;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: '변경 사유' })
  reason: string | null;

  @Column({ type: 'int', comment: '변경자 user.id' })
  changedByUserId: number;

  @Column({ type: 'varchar', length: 100, comment: '변경자 이메일 (스냅샷)' })
  changedByEmail: string;

  @CreateDateColumn()
  createdAt: Date;
}
