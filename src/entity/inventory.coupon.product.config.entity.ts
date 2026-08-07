import { Column, Entity, PrimaryColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

/**
 * 상품별 재고형 쿠폰 고정 설정 (product_id 1:1).
 * rev5 §4.2.
 */
@Entity('inventory_coupon_product_config')
export class InventoryCouponProductConfigEntity extends BaseEntity {
  @PrimaryColumn({ type: 'bigint', comment: 'FK) product.id, 1:1' })
  productId: number;

  @Column({ type: 'decimal', precision: 19, scale: 4, comment: '액면가 (0 초과)' })
  faceValueAmount: string;

  @Column({ type: 'char', length: 3, comment: 'ISO 4217 통화코드' })
  currencyCode: string;

  @Column({ type: 'varchar', length: 100, comment: '주코드 라벨 (예: Claim Code)' })
  primaryCodeLabel: string;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '보조코드 라벨 (NULL이면 보조코드 렌더링 금지)' })
  secondaryCodeLabel: string | null;

  @Column({ type: 'text', comment: '사용방법 (영어 일반 텍스트)' })
  howToUse: string;

  @Column({ type: 'text', comment: '유의사항 (영어 일반 텍스트)' })
  notice: string;

  @Column({ type: 'varchar', length: 10, default: 'en', comment: '템플릿 로케일 (1차 en만 허용)' })
  templateLocale: string;

  @Column({ type: 'int', default: 0, comment: '저재고 임계치 (0 이상)' })
  lowStockThreshold: number;

  @Column({ type: 'varchar', length: 100, comment: '기본 발신 이메일' })
  defaultFromEmail: string;

  @Column({ type: 'varchar', length: 255, comment: '기본 제목 (주문에 제목이 없을 때)' })
  defaultSubject: string;

  @Column({ type: 'int', default: 1, comment: '낙관적 잠금/스냅샷 버전' })
  version: number;

  @Column({ type: 'int', default: 0, comment: '유효기간 일수 (0이면 제한 없음)' })
  validityDays: number;

  @Column({ type: 'tinyint', width: 1, default: 0, comment: '유효기간 시작이 다음날(1) vs 당일(0)' })
  validityStartsNextDay: boolean;

  @Column({ type: 'int', default: 1, comment: '코드 구조 버전 (primary/secondary 존재 구조)' })
  codeSchemaVersion: number;
}
