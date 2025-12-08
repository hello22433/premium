import { BaseEntity } from '../common/entity/base.entity';
import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { IProductSettleMethod } from '../product/interface/product.settle.method';
import { IProductType } from '../product/interface/product.type';
import { PartnerCompanyEntity } from './partner.company.entity';
import { BrandEntity } from './brand.entity';
import { ClassificationEntity } from './classification.entity';
import { IProductUseStatus } from '../product/interface/product.status';
import { IRealProductStatus } from '../product/interface/real.product.status';
import { ProductChoiceMappingEntity } from './product.choice.mapping.entity';
import { ProductLikeEntity } from './product.like.entity';

@Entity('product')
export class ProductEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 256, unique: true, comment: '상품 코드' })
  code: string;

  @Column({ type: 'varchar', length: 256, comment: '협력사 상품 코드, 발행시 필요', nullable: true })
  partnerCompanyCode: string | null;

  @Column({ comment: 'FK) partner_company.id 협력사' })
  partnerCompanyId: number;

  @Column({ comment: 'FK) brand.id' })
  brandId: number;

  @Column({ type: 'varchar', length: 100, comment: '상품 명' })
  name: string;

  @Column({ comment: '가격' })
  price: number;

  @Column({ comment: '유효 기간 (일)' })
  expireDay: number;

  @Column({ type: 'varchar', length: 50, comment: '상품군 ex) A,B,C,D' })
  category: string;

  @Column({ nullable: true, comment: 'FK) classification.id 대분류' })
  classificationId: number | null;

  @Column({
    type: 'varchar',
    length: 50,
    comment: '정산 방법 ex) 교환당 : PER_EXCHANGE, 발행당: PER_ISSUANCE, 상품당: PER_PRODUCT',
  })
  settleMethod: IProductSettleMethod;

  @Column({ type: 'decimal', precision: 5, scale: 2, comment: '정산 조건 (퍼센트), ex) 30.55 = 30.55%' })
  settlePercent: number;

  @Column({ type: 'varchar', length: 512, comment: '미리 보기 이미지 path' })
  imagePath: string;

  @Column({
    type: 'varchar',
    length: 100,
    comment: '상품유형 ex) 일반: GENERAL, 초이스: CHOICE, 배송: DELIVERY, 자체: SELF, 신세계 : SSG, 실물상품: REAL',
  })
  type: IProductType;

  @Column({ type: 'varchar', length: 10, comment: '쿠폰번호 생성 방법' })
  couponMethod: string;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: '유의사항' })
  memo: string | null;

  @Column({ comment: '상품 사용 상태 ex) 사용: USE 미사용: UNUSED 영구 미사용: PERMANENTLY_UNUSED' })
  useStatus: IProductUseStatus;

  @Column({ type: 'varchar', nullable: true, length: 100, comment: '실물상품 색상 ' })
  color: string | null;

  @Column({
    type: 'enum',
    enum: IRealProductStatus,
    comment: '실물상품 판매상태 ex) ON_SALE: 판매중, CLOSED: 판매중지',
    nullable: true,
  })
  status: IRealProductStatus;

  @ManyToOne(() => PartnerCompanyEntity, {
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'partner_company_id' })
  partnerCompany?: PartnerCompanyEntity;

  @ManyToOne(() => BrandEntity, {
    createForeignKeyConstraints: false,
  })
  brand?: BrandEntity;

  @ManyToOne(() => ClassificationEntity, {
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'classification_id' })
  classification?: ClassificationEntity;

  @OneToMany(() => ProductChoiceMappingEntity, (productChoiceMapping) => productChoiceMapping.choiceProduct, {
    createForeignKeyConstraints: false,
  })
  productChoiceMappings: ProductChoiceMappingEntity[];

  @OneToMany(() => ProductLikeEntity, (productLike) => productLike.product, {
    createForeignKeyConstraints: false,
  })
  productLikes?: ProductLikeEntity[];
}
