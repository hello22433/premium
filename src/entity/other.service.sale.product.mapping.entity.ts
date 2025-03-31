import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { OtherServiceSaleEntity } from './other.service.sale.entity';
import { OtherServiceSaleProductEntity } from './other.service.sale.product.entity';

@Entity('other_service_sale_product_mapping')
export class OtherServiceSaleProductMappingEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) 기타 서비스 매출 id' })
  otherServiceSaleId: number;

  @Column({ comment: 'FK) 기타 서비스 매출 상품 id' })
  otherServiceSaleProductId: number;

  @Column({ type: 'int', comment: '수량' })
  quantity: number;

  @Column({ type: 'int', comment: '공급가(단가 x 수량)' })
  totalPrice: number;

  @ManyToOne(() => OtherServiceSaleEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'other_service_sale_id' })
  otherServiceSale: OtherServiceSaleEntity;

  @ManyToOne(() => OtherServiceSaleProductEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'other_service_sale_product_id' })
  otherServiceSaleProduct: OtherServiceSaleProductEntity;
}
