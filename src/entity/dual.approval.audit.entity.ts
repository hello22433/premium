import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { DualApprovalAuditEvent } from '../delivery/interface/dual.approval.status';

/**
 * DUAL_APPROVAL append-only 감사 로그. §8.2.
 *
 * 요청·1차 승인·2차 승인·반려·무효화·최종 사용 각각을 승인자·시각·사유·payload hash 와 함께 남긴다.
 * **추가 전용**이며 수정·삭제하지 않는다. 사유·근거에 민감정보를 원문으로 남기지 않는다(§8.3).
 */
@Entity('dual_approval_audit')
@Index('idx_dual_approval_audit_approval', ['approvalId', 'createdAt'])
export class DualApprovalAuditEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', comment: 'FK) dual_approval.id' })
  approvalId: string;

  @Column({ type: 'varchar', length: 24 })
  event: DualApprovalAuditEvent;

  @Column({ type: 'int', nullable: true, comment: '행위자 user.id (시스템 무효화는 NULL)' })
  actorUserId: number | null;

  @Column({ type: 'char', length: 64, comment: '이벤트 시점 payload hash' })
  payloadHash: string;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: '사유(민감정보 금지)' })
  reason: string | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}
