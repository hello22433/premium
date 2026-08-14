import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { SsgPinResolution } from '../partner_company_extern/interface/ssg.issue';

/**
 * EP-P30 §9-3 관측 후보별 결과.
 *
 * 다중 후보의 `tryYn`/`resultCd` 를 run 한 행에 뭉개면 모호하므로 후보별로 풀어 저장하고,
 * run 에는 집계 결과만 둔다.
 */
@Entity('ssg_pin_observation_candidate')
@Index('uq_ssg_pin_observation_candidate', ['runId', 'ssgIssueLogId'], { unique: true })
export class SsgPinObservationCandidateEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'run_id', comment: 'FK) ssg_pin_observation_run.id' })
  runId: string;

  @Column({ type: 'int', name: 'ssg_issue_log_id', comment: 'FK) ssg_issue_log.id' })
  ssgIssueLogId: number;

  @Column({ type: 'varchar', length: 1, name: 'try_yn', nullable: true, comment: "GetSsgTry tryYn ('Y'|'N')" })
  tryYn: string | null;

  @Column({ type: 'varchar', length: 8, name: 'result_cd', nullable: true, comment: 'GetSsgStatus resultCd' })
  resultCd: string | null;

  @Column({ type: 'varchar', length: 24, comment: '후보 판정' })
  resolution: SsgPinResolution;
}
