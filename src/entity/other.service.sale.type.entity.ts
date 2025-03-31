import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

@Entity('other_service_sale_type')
export class OtherServiceSaleTypeEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', comment: ' 코드' })
  code: string;

  @Column({ type: 'varchar', comment: '판매유형' })
  name: string;
}
