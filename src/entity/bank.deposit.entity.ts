import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import { DepositMatchStatus } from '../deposit/interface/deposit.match.status';

/**
 * ECOUNT 입출금 거래내역 미러 (프리미엄 소유).
 *
 * erp_macro 가 ECOUNT 를 긁어 자기 DB 에 raw 로 저장하고 조회 API 로 노출하면,
 * 프리미엄이 그 API 를 주기적으로 호출해 이 테이블에 미러링한다. 화면은 이 테이블을 읽는다.
 * (계약: docs/API계약-erp_macro-입금내역-조회.md, 스키마: migration/bank-deposit-mirror.sql)
 *
 * ⚠️ 컬럼 소유권이 두 갈래다.
 *   · [원본] erp_macro 가 정본 — 동기화가 매 주기 덮어쓴다.
 *   · [프리미엄] matchedUserId / matchStatus — 프리미엄만 쓴다. 동기화가 건드리면
 *     운영자가 방금 지정한 매칭이 다음 주기에 UNMATCHED 로 되돌아간다.
 *     그래서 upsert 는 갱신 컬럼을 명시적으로 열거한다(deposit.sync.service.ts).
 *
 * 금액(amount/balance)은 은행 거래 사실이지 고객 예치금·미수금이 아니다.
 * 고객 잔액의 정본은 wallet_account 이며 이 테이블과 무관하다.
 */
@Entity('bank_deposit')
@Unique('uk_bank_deposit_dedup', ['dedupKey'])
@Index('idx_bank_deposit_tx_date', ['txDate'])
@Index('idx_bank_deposit_depositor', ['depositor'])
@Index('idx_bank_deposit_match_status', ['matchStatus'])
@Index('idx_bank_deposit_account_no', ['accountNo'])
export class BankDepositEntity {
  @PrimaryGeneratedColumn()
  id: number;

  // ===== 원본 미러 (erp_macro 정본) =====

  @Column({ type: 'varchar', length: 64, comment: 'erp_macro 지문. 멱등 upsert 키' })
  dedupKey: string;

  /**
   * DATE 컬럼. TypeORM 이 하이드레이션 시 'YYYY-MM-DD' 문자열로 정규화하므로
   * 런타임 타입은 Date 가 아니라 string 이다(프로세스 TZ = Asia/Seoul, main.ts).
   * Date 로 선언하면 JSON 직렬화에서 UTC 로 밀려 화면 날짜가 하루 어긋난다.
   * 같은 이유로 이 컬럼은 getRawMany() 로 읽으면 안 된다(정규화를 건너뛴다).
   */
  @Column({ type: 'date', comment: 'ECOUNT 일자' })
  txDate: string;

  @Column({ type: 'varchar', length: 10, comment: 'ECOUNT 구분 원문: 입금/출금' })
  txType: string;

  @Column({ type: 'varchar', length: 50, comment: '계좌번호(마스킹형). 계좌 식별은 이 컬럼으로' })
  accountNo: string;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: 'ECOUNT 계좌명. 은행명/회사명/용도가 섞여 있어 식별자로 쓰지 말 것',
  })
  accountName: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, comment: 'ECOUNT 거래처코드' })
  erpPartnerCode: string | null;

  @Column({ type: 'varchar', length: 191, nullable: true, comment: 'ECOUNT 거래처명' })
  erpPartnerName: string | null;

  @Column({ type: 'varchar', length: 191, comment: '입금처 - (가상) 접두 제거본' })
  depositor: string;

  @Column({ type: 'varchar', length: 191, nullable: true, comment: '입금처 원문' })
  depositorRaw: string | null;

  /** BIGINT 는 드라이버가 string 으로 돌려준다(JS number 정밀도 보호). 응답 변환은 서비스에서. */
  @Column({ type: 'bigint', comment: '금액(원)' })
  amount: string;

  @Column({ type: 'bigint', comment: '거래후 잔액(원)' })
  balance: string;

  @Column({
    type: 'varchar',
    length: 50,
    nullable: true,
    comment: '회계전표번호. 숫자가 아닐 수 있음(강제회계반영 등) — 파싱 금지',
  })
  voucherNo: string | null;

  // ===== 프리미엄 소유 (동기화가 덮지 않는다) =====

  @Column({ type: 'int', nullable: true, comment: 'FK) user.id. FK 제약 없는 논리 참조' })
  matchedUserId: number | null;

  @Column({ type: 'varchar', length: 20, default: DepositMatchStatus.UNMATCHED })
  matchStatus: string;

  // ===== 동기화 메타 =====

  @Column({ type: 'datetime', precision: 6, comment: 'erp_macro 가 ECOUNT 를 긁은 시각' })
  sourceScrapedAt: Date;

  @Column({ type: 'datetime', precision: 6, comment: 'erp_macro 쪽 행 갱신 시각(회계전표 반영 추적용)' })
  sourceUpdatedAt: Date;

  @Column({ type: 'datetime', precision: 6, comment: '이 행을 마지막으로 받아온 시각' })
  syncedAt: Date;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
