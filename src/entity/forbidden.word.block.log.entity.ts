import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('forbidden_word_block_log')
export class ForbiddenWordBlockLogEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: '차단당한 작성자 user.id' })
  userId: number;

  @Column({ type: 'varchar', length: 100, comment: '작성자 이메일 (스냅샷)' })
  userEmail: string;

  @Column({ type: 'json', comment: '적발된 금칙어 배열' })
  matchedWords: string[];

  @Column({ type: 'varchar', length: 50, comment: '적발 필드 (sendContent 등)' })
  field: string;

  @Column({ type: 'varchar', length: 500, comment: '적발 내용 일부 (절단)' })
  contentSnippet: string;

  @Column({ type: 'int', nullable: true, comment: '연관 임시주문 order.id (있으면)' })
  orderId: number | null;

  @CreateDateColumn()
  createdAt: Date;
}
