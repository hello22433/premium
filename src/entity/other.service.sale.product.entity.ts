import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

@Entity('other_service_sale_product')
export class OtherServiceSaleProductEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', comment: '품목코드' })
  code: string;

  @Column({ type: 'varchar', comment: '브랜드명' })
  brandName: string;

  @Column({ type: 'varchar', comment: '품목 명' })
  name: string;

  @Column({ type: 'int', comment: '금액(단가)' })
  price: number;
}
