import { BaseEntity } from '../common/entity/base.entity';
import { Column, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { UserEntity } from './user.entity';
import { RequirementType } from '../requirement/interface/requirement.type';
import { RequirementStatus } from '../requirement/interface/requirement.status';
import { RequirementPriority } from '../requirement/interface/requirement.priority';
import { RequirementCommentEntity } from './requirement.comment.entity';
import { RequirementAttachmentEntity } from './requirement.attachment.entity';

@Entity('requirement')
export class RequirementEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) user.id, 등록한 관리자 id' })
  userId: number;

  @Column({ type: 'varchar', length: 100, comment: '제목' })
  title: string;

  @Column({
    type: 'varchar',
    length: 50,
    comment: '유형 ex) NEW_FEATURE: 신규기능, MODIFICATION: 수정, BUG: 버그',
  })
  type: RequirementType;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '관련 페이지' })
  relatedPage: string | null;

  @Column({
    type: 'varchar',
    length: 50,
    comment: '우선순위 ex) URGENT: 긴급, HIGH: 높음, NORMAL: 보통',
  })
  priority: RequirementPriority;

  @Column({ type: 'text', comment: '상세 내용' })
  content: string;

  @Column({
    type: 'varchar',
    length: 50,
    default: RequirementStatus.NEW,
    comment: '상태 ex) NEW: 신규, REVIEW: 검토중, IN_PROGRESS: 진행중, COMPLETE: 완료',
  })
  status: RequirementStatus;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  user: UserEntity;

  @OneToMany(() => RequirementCommentEntity, (comment) => comment.requirement)
  comments: RequirementCommentEntity[];

  @OneToMany(() => RequirementAttachmentEntity, (attachment) => attachment.requirement)
  attachments: RequirementAttachmentEntity[];
}
