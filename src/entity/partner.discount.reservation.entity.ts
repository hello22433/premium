import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { IUserDiscountCategory } from '../user_discount/interface/user.discount.category';
import { IUserDiscountMethod } from '../user_discount/interface/user.discount.method';
import { ICompareCondition } from '../user_discount/interface/compare.condition';
import { IPriceAdjustment } from '../user_discount/interface/price.adjustment';
import {
  IPartnerDiscountReservationFailureCode,
  IPartnerDiscountReservationStatus,
} from '../partner_settle/interface/partner.discount.reservation.status';

/**
 * 협력사 정산조건 예약.
 *
 * 등록 시점에는 아무 것도 발효되지 않는다. cron 이 `effectiveAt` 을 지난 PENDING 을 집어
 * `partner_discount_history` 구간을 만들면서 APPLIED 로 넘긴다.
 *
 * DB 가 강제하는 불변식(마이그레이션 `20260807_partner_settle_pr3b_reservation.sql`):
 * - `UNIQUE(scope_key, effective_at, active_key)` — 같은 scope·같은 시각의 PENDING 정확히 1건.
 *   active_key = `CASE WHEN status = 'PENDING' THEN 1 END` (generated STORED, 엔티티 미매핑).
 *   `BLOCKED` 는 NULL 이라 재예약을 막지 않는다 — BLOCKED 해제는 취소 후 재예약이기 때문.
 * - `UNIQUE(request_key)` — 응답 유실 재시도가 예약을 두 건 만들지 않는다.
 * - 할인율 절대 상한: DISCOUNT 0~100 · ADDITIONAL 0~1000 (history 와 동일 CHECK)
 */
@Entity('partner_discount_reservation')
@Index('idx_partner_discount_reservation_due', ['status', 'effectiveAt'])
@Index('idx_partner_discount_reservation_partner', ['partnerCompanyId'])
export class PartnerDiscountReservationEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'FK) partner_company.id' })
  partnerCompanyId: number;

  @Column({ type: 'varchar', length: 24, comment: '[scope] 할인 분류 PRODUCT_GROUP|CATEGORY|BRAND' })
  category: IUserDiscountCategory;

  @Column({ type: 'int', nullable: true, comment: '[scope] FK) classification.id' })
  classificationId: number | null;

  @Column({ type: 'varchar', length: 16, comment: '[scope] 할인 방법 SECTION|BULK' })
  method: IUserDiscountMethod;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '[scope] 브랜드' })
  primaryCategory: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '[scope] 상품군' })
  group: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '[scope] 구간' })
  range: string | null;

  @Column({ type: 'varchar', length: 16, comment: '[scope] 비교 조건' })
  compareCondition: ICompareCondition;

  // history 와 같은 binary 대조. 기본 대조면 canonical key 비교가 case-insensitive 가 되어
  // 서로 다른 scope 의 예약이 같은 UNIQUE 슬롯을 다투게 된다.
  @Column({
    type: 'varchar',
    length: 255,
    charset: 'utf8mb4',
    collation: 'utf8mb4_bin',
    comment: 'canonical scopeKey (sk1|...)',
  })
  scopeKey: string;

  @Column({ type: 'int', comment: '예약된 수수료 (percent)' })
  pricePercent: number;

  @Column({ type: 'varchar', length: 16, comment: 'DISCOUNT|ADDITIONAL' })
  priceAdjustment: IPriceAdjustment;

  @Column({ type: 'datetime', precision: 6, comment: '적용 시각. history 의 validFrom 이 되는 값' })
  effectiveAt: Date;

  @Column({ type: 'varchar', length: 16, comment: 'PENDING|APPLIED|CANCELED|BLOCKED' })
  status: IPartnerDiscountReservationStatus;

  @Column({ type: 'int', comment: 'FK) user.id 등록자' })
  registeredBy: number;

  @Column({ type: 'int', nullable: true, comment: 'FK) partner_discount_history.id — 발효로 생긴 새 값 구간' })
  resultHistoryId: number | null;

  @Column({ type: 'varchar', length: 100, comment: '생성 멱등 키' })
  requestKey: string;

  @Column({ type: 'varchar', length: 100, comment: '생성 요청 정규화 hash. 같은 key·다른 payload = 409' })
  payloadHash: string;

  @Column({ type: 'varchar', length: 8, default: 'v1', comment: 'payloadHash canonicalization 버전' })
  payloadHashVersion: string;

  /**
   * 생성 시점에 박제한 소급 여부. cron 이 "지연된 미래 예약" 과 "진짜 소급" 을 구분하는 유일한 근거다.
   * cron 실행 시각으로 `effectiveAt < now` 를 다시 판정하면 둘 다 과거라 구분되지 않는다.
   */
  @Column({ type: 'tinyint', width: 1, comment: '생성 시점 기준 소급 여부 (effectiveAt < createdAt)' })
  isRetroactive: boolean;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: '마지막 발효 실패 코드' })
  lastFailureCode: IPartnerDiscountReservationFailureCode | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, comment: '마지막 발효 실패 시각' })
  lastFailureAt: Date | null;
}
