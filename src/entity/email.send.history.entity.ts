import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { EmailType } from '../mail/domain/email.type';
import { BaseEntity } from '../common/entity/base.entity';

@Entity('email_send_history')
export class EmailSendHistoryEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ type: 'int', nullable: true, comment: '주문 발송 ID (이메일 쿠폰용)' })
  orderDeliveryId: number | null;

  @Index()
  @Column({ type: 'int', nullable: true, comment: '주문 ID (리포트 이메일용)' })
  orderId: number | null;

  @Index()
  @Column({ type: 'int', nullable: true, comment: '사용자 ID (로그인 인증용)' })
  userId: number | null;

  @Index()
  @Column({ type: 'varchar', length: 200, comment: '이메일' })
  email: string;

  @Column({
    type: 'enum',
    enum: EmailType,
    comment: '이메일 인증 type ex) 로그인: LOGIN, 비밀번호 변경 관련: PASSWORD, 쿠폰 발송: COUPON, 발송완료리포트: DELIVERY_COMPLETE_REPORT',
  })
  type: EmailType;

  @Column({ type: 'varchar', nullable: true, comment: '인증 코드' })
  code: string | null;

  @Column({ type: 'boolean', default: false, comment: '인증 여부' })
  isCertified: boolean;

  @Column({ type: 'datetime', nullable: true, comment: '만료 일자' })
  expireAt: Date | null;

  @Column({ type: 'varchar', length: 200, nullable: true, comment: '이메일 제목 (리포트용)' })
  subject: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, comment: 'SMTP 메시지 ID' })
  messageId: string | null;

  @Column({ type: 'boolean', nullable: true, comment: '발송 성공 여부' })
  isSuccess: boolean | null;

  @Column({ type: 'text', nullable: true, comment: '발송 실패 시 에러 메시지' })
  errorMessage: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '첨부 파일명' })
  attachmentFileName: string | null;
}
