import { BaseEntity } from '../common/entity/base.entity';
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { RequirementEntity } from './requirement.entity';

@Entity('requirement_attachment')
export class RequirementAttachmentEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) requirement.id' })
  requirementId: number;

  @Column({ type: 'varchar', length: 500, comment: '파일 URL' })
  fileUrl: string;

  @Column({ type: 'varchar', length: 200, comment: '파일명' })
  fileName: string;

  @ManyToOne(() => RequirementEntity, (requirement) => requirement.attachments, {
    createForeignKeyConstraints: false,
  })
  requirement: RequirementEntity;
}
