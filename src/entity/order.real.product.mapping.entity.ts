import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { IPublicChargeTaxPaymentType } from '../order_real_product/interface/public.charge.tax.payment.type';
import { IProcessMethod } from '../order_real_product/interface/process.method';
import { OrderRealProductEntity } from './order.real.product.entity';
import { ProductEntity } from './product.entity';

@Entity('order_real_product_mapping')
export class OrderRealProductMappingEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ comment: 'FK) order real product id' })
  realProductOrderId: number;

  @Column({ comment: 'FK) product id' })
  productId: number;

  @Column({ type: 'int', comment: '상품 수량' })
  quantity: number;

  @Column({ type: 'int', comment: '공급가액' })
  price: number;

  @Column({ type: 'int', comment: '상품의 총 금액(부가세 포함)' })
  totalPrice: number;

  @Column({ type: 'int', comment: '기준가액' })
  standardAmount: number;

  @Column({ type: 'int', comment: '납부 총 금액(제세공과금 포함)' })
  totalTaxAmount: number;

  @Column({
    type: 'enum',
    enum: IPublicChargeTaxPaymentType,
    comment: '제세공과금 납부 방법 ex) PERSON: 고객납부, COMPANY: 고객사대납',
  })
  publicChargeTaxPayment: IPublicChargeTaxPaymentType;

  @Column({
    type: 'enum',
    enum: IProcessMethod,
    comment: '처리 방식 ex) PRE: 사전처리, POST: 사후처리',
  })
  processMethod: IProcessMethod;

  @Column({
    type: 'boolean',
    comment: '처리 여부 선택 ex) 처리: true, 미처리: false',
  })
  isProcess: boolean;

  @ManyToOne(() => OrderRealProductEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'real_product_order_id' })
  realProductOrder: OrderRealProductEntity;

  @ManyToOne(() => ProductEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'product_id' })
  product: ProductEntity;
}
