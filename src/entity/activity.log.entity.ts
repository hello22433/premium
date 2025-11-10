import { BaseEntity } from '../common/entity/base.entity';
import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { UserEntity } from './user.entity';

@Entity('activity_log')
export class ActivityLogEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'FK) user.id 활동 계정 ID' })
  userId: number;

  @Column({ type: 'varchar', length: 100, comment: '활동 계정 이메일' })
  userEmail: string;

  @Column({ type: 'varchar', length: 10, comment: 'HTTP 메소드 (GET, POST 등)' })
  method: string;

  @Column({ type: 'varchar', length: 500, comment: '요청 URL/서비스' })
  requestUrl: string;

  @Column({ type: 'varchar', length: 100, comment: '액션 타입 (EXCEL_DOWNLOAD, LOGIN 등)' })
  actionType: string;

  @Column({ type: 'varchar', length: 50, comment: '접속 IP' })
  ipAddress: string;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: 'User Agent' })
  userAgent: string | null;

  @Column({ type: 'int', comment: 'HTTP 상태 코드 (200, 404, 500 등)' })
  statusCode: number;

  @Column({ type: 'varchar', length: 1, comment: '결과 (O: 성공, X: 실패)' })
  result: string;

  @Column({ type: 'int', comment: '응답 시간 (ms)', default: 0 })
  responseTime: number;

  @Column({ type: 'text', nullable: true, comment: '다운로드 사유 (엑셀 다운로드 시)' })
  downloadReason: string | null;

  @Column({ type: 'int', nullable: true, comment: '다운로드된 레코드 수' })
  recordCount: number | null;

  @Column({ type: 'json', nullable: true, comment: '요청 파라미터 (검색 조건 등)' })
  requestParams: any;

  @Column({ type: 'text', nullable: true, comment: '에러 메시지 (실패 시)' })
  errorMessage: string | null;

  @ManyToOne(() => UserEntity, {
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;
}
