import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import { DepositMatchStatus } from '../deposit/interface/deposit.match.status';
import { WalletAccountOwnerType } from './wallet.account.entity';

/**
 * ECOUNT 입출금 거래내역 미러 (프리미엄 소유).
 *
 * erp_macro 가 ECOUNT 를 긁어 자기 DB 에 raw 로 저장하고 조회 API 로 노출하면,
 * 프리미엄이 그 API 를 주기적으로 호출해 이 테이블에 미러링한다. 화면은 이 테이블을 읽는다.
 * (계약: docs/API계약-erp_macro-입금내역-조회.md, 스키마: migration/bank-deposit-mirror.sql)
 *
 * `synchronize: false` 는 스키마 자동변경 잠금이다. 전역 스위치(DATABASE_SYNCHRONIZE)가
 * 모든 환경에서 꺼져 있어 지금은 아무 일도 일어나지 않지만, 누군가 로컬에서 켜는 순간
 * TypeORM 이 이 테이블을 자기 판단대로 ALTER 하게 된다. 이 테이블은 DDL 을 수기 SQL 로
 * 관리하는(migration/bank-deposit-mirror.sql) 돈 데이터라, 유지 비용 0 인 잠금을 굳이 뗄 이유가 없다.
 * (소유권이 프리미엄으로 넘어온 것과 이 잠금은 별개 문제다)
 *
 * ⚠️ 컬럼 소유권이 두 갈래다.
 *   · [원본] erp_macro 가 정본 — 동기화가 매 주기 덮어쓴다.
 *   · [프리미엄] matchedOwnerType / matchedOwnerId / matchStatus — 프리미엄만 쓴다. 동기화가 건드리면
 *     운영자가 방금 지정한 매칭이 다음 주기에 UNMATCHED 로 되돌아간다.
 *     그래서 upsert 는 갱신 컬럼을 명시적으로 열거한다(deposit.sync.service.ts).
 *
 * 금액(amount/balance)은 은행 거래 사실이지 고객 예치금·미수금이 아니다.
 * 고객 잔액의 정본은 wallet_account 이며 이 테이블과 무관하다.
 */
@Entity('bank_deposit', { synchronize: false })
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

  // ===== PII 4종 — 암호화 저장 =====
  // erp_macro 가 자기 DB 에 암호화 보관하는 값이라 미러도 같은 수준을 유지한다.
  // 저장/조회는 서비스 계층에서 CryptoCipher.encryptDeliveryTarget / safeDecryptDeliveryTarget
  // 으로 명시 처리한다(이 레포 관례 — delivery_send_history.target 과 동일. transformer 미사용).
  // ⚠️ 이 프로퍼티들에 담긴 값은 **암호문**이다. 응답으로 내보내기 전에 반드시 복호화할 것.

  @Column({ type: 'varchar', length: 512, nullable: true, comment: 'ECOUNT 거래처코드 (암호화 저장)' })
  erpPartnerCode: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true, comment: 'ECOUNT 거래처명 (암호화 저장)' })
  erpPartnerName: string | null;

  /**
   * ⚠️ nullable 이다. ECOUNT 원장에 입금처가 비는 행이 있고(수수료·자동이체 등), NOT NULL 로 두면
   * 그런 행 하나가 페이지 단위 multi-row INSERT 전체를 되돌려 백필이 영영 수렴하지 못한다.
   */
  @Column({ type: 'varchar', length: 512, nullable: true, comment: '입금처 - (가상) 접두 제거본 (암호화 저장)' })
  depositor: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true, comment: '입금처 원문 (암호화 저장)' })
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

  /**
   * 귀속 대상은 고객(user)이 아니라 **예치금 지갑의 주인**이다.
   *
   * 지갑(wallet_account)은 주인을 (ownerType, ownerId) **쌍**으로 표현하므로 미러도 같은 쌍을
   * 복사한다. 현재 유효한 타입은 'SETTLEMENT_CODE' 하나뿐이고 그때 ownerId = user.settlementCode 다.
   * 타입이 하나뿐인데도 컬럼을 함께 두는 이유는 지갑 주인 단위 확장이 예정되어 있어서다 —
   * id 만 저장하면 확장 시점에 기존 행이 어느 타입이었는지 사후 판별이 불가능하다.
   *
   * user 로 잡지 않는 이유: 정산코드 하나를 여러 user 가 공유하므로 어느 user 를 골라도 돈은
   * 같은 지갑으로 가는 무의미한 자유도가 생기고, settlementCode 가 없는 user 에 매칭하면
   * 매칭은 통과하고 충전 단계에서 실패하는 지연 실패가 된다.
   *
   * ⚠️ 두 컬럼은 항상 함께 채우거나 함께 비운다(DB CHECK: chk_bank_deposit_matched_owner).
   */
  @Column({
    type: 'varchar',
    length: 20,
    nullable: true,
    comment: 'wallet_account.owner_type. 현재 SETTLEMENT_CODE 단일',
  })
  matchedOwnerType: WalletAccountOwnerType | null;

  @Column({ type: 'varchar', length: 50, nullable: true, comment: 'wallet_account.owner_id. FK 제약 없는 논리 참조' })
  matchedOwnerId: string | null;

  @Column({ type: 'varchar', length: 20, default: DepositMatchStatus.UNMATCHED })
  matchStatus: string;

  // ===== 동기화 메타 =====

  /**
   * erp_macro 가 이 거래를 **처음 목격한** 시각. 재스크래핑으로 갱신되지 않는다
   * (상대 BankDepositMirrorService 가 재목격 시 voucherNo/거래처만 refresh 한다).
   * 따라서 "원본이 마지막으로 바뀐 시각"을 뜻하지 않는다 — 그 신호는 상대 API 에 없다.
   */
  @Column({ type: 'datetime', precision: 6, comment: 'erp_macro 가 이 거래를 처음 목격한 시각' })
  sourceScrapedAt: Date;

  @Column({ type: 'datetime', precision: 6, comment: '이 행을 마지막으로 받아온 시각' })
  syncedAt: Date;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
