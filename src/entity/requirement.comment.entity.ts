import { BaseEntity } from '../common/entity/base.entity';
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { UserEntity } from './user.entity';
import { RequirementEntity } from './requirement.entity';

@Entity('requirement_comment')
export class RequirementCommentEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) requirement.id' })
  requirementId: number;

  @Column({ comment: 'FK) user.id, 댓글 작성자 id' })
  userId: number;

  @Column({ type: 'text', comment: '댓글 내용' })
  content: string;

  @ManyToOne(() => RequirementEntity, (requirement) => requirement.comments, {
    createForeignKeyConstraints: false,
  })
  requirement: RequirementEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  user: UserEntity;
}
