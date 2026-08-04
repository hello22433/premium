import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * ECOUNT 입출금 거래내역 미러.
 *
 * ⚠️ 이 테이블의 소유자는 프리미엄이 아니다. 별도 서비스 erp_macro 가 ECOUNT 를
 * 스크래핑해 write 하고, 프리미엄은 read 만 한다. 여기서 INSERT/UPDATE/DELETE 를
 * 하면 스크래퍼의 지문(dedup_key) 기반 upsert 와 충돌해 미러가 원본과 어긋난다.
 *
 * `synchronize: false` 는 그 소유권을 코드로 강제하는 장치다. 전역
 * DATABASE_SYNCHRONIZE 가 켜져도 TypeORM 이 이 테이블만은 ALTER/DROP 하지 않는다.
 * 스키마 정본은 erp_macro 의 수기 DDL(sql/migrations/20260722_create_deposit_recon_tables.sql).
 *
 * 금액(amount/balance)은 은행 거래 사실이지 고객 예치금·미수금이 아니다.
 * 고객 잔액의 정본은 wallet_account 이며 이 테이블과 무관하다.
 */
@Entity('bank_deposit', { synchronize: false })
@Unique('uk_bank_deposit_dedup', ['dedupKey'])
@Index('idx_bank_deposit_depositor', ['depositor'])
@Index('idx_bank_deposit_tx_date', ['txDate'])
@Index('idx_bank_deposit_match_status', ['matchStatus'])
export class BankDepositEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 64, comment: '중복방지 지문 = SHA-256(계좌|일자|구분|금액|잔액|입금처)' })
  dedupKey: string;

  /**
   * DATE 컬럼. TypeORM 이 하이드레이션 시 'YYYY-MM-DD' 문자열로 정규화하므로
   * 런타임 타입은 Date 가 아니라 string 이다(프로세스 TZ = Asia/Seoul, main.ts).
   * Date 로 선언하면 JSON 직렬화에서 UTC 로 밀려 화면 날짜가 하루 어긋난다.
   * 같은 이유로 이 컬럼은 getRawMany() 로 읽으면 안 된다(정규화를 건너뛴다).
   */
  @Column({ type: 'date', comment: 'ECOUNT 일자' })
  txDate: string;

  @Column({ type: 'varchar', length: 10, comment: 'ECOUNT 구분: 입금/출금' })
  txType: string;

  @Column({ type: 'varchar', length: 50, comment: 'ECOUNT 계좌번호(수취계좌, 마스킹형)' })
  accountNo: string;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: 'ECOUNT 계좌명' })
  accountName: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, comment: 'ECOUNT 거래처코드' })
  erpPartnerCode: string | null;

  @Column({ type: 'varchar', length: 191, nullable: true, comment: 'ECOUNT 거래처명' })
  erpPartnerName: string | null;

  @Column({ type: 'varchar', length: 191, comment: '입금처 - (가상) 접두 제거본. 매핑 키의 원본' })
  depositor: string;

  @Column({ type: 'varchar', length: 191, nullable: true, comment: '입금처 원문 그대로(감사/디버깅용)' })
  depositorRaw: string | null;

  /** BIGINT 는 드라이버가 string 으로 돌려준다(JS number 정밀도 보호). 응답 변환은 서비스에서. */
  @Column({ type: 'bigint', comment: '금액(원)' })
  amount: string;

  @Column({ type: 'bigint', comment: '거래후 잔액(원). 지문의 타이브레이커' })
  balance: string;

  @Column({ type: 'varchar', length: 50, nullable: true, comment: '회계전표번호(미반영 시 NULL)' })
  voucherNo: string | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) user.id, 매핑으로 연결된 고객(미매핑이면 NULL)' })
  matchedUserId: number | null;

  @Column({ type: 'varchar', length: 20, comment: 'UNMATCHED/MAPPED/AMBIGUOUS/CREDITED' })
  matchStatus: string;

  @Column({ type: 'datetime', precision: 6, comment: '스크래핑 시각' })
  scrapedAt: Date;

  // @CreateDateColumn/@UpdateDateColumn 을 쓰지 않는다 — 값을 쓰는 쪽은 erp_macro 이고,
  // 프리미엄이 실수로 save() 를 호출해도 이 컬럼들을 덮어쓰지 않게 평범한 @Column 으로 둔다.
  @Column({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @Column({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
