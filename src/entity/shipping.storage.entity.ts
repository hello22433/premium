import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

@Entity('shipping_storage')
export class ShippingStorageEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', comment: ' 창고 코드' })
  code: string;

  @Column({
    type: 'int',
    comment: ' 창고 타입 ex) STORAGE: 창고, FACTORY: 공장, OUTSOURCING_FACTORY: 공장(외주비관리) ',
  })
  type: IShippingStorageType;

  @Column({ type: 'varchar', comment: '창고명' })
  name: string;
}

export enum IShippingStorageType {
  STORAGE = 'STORAGE',
  FACTORY = 'FACTORY',
  OUTSOURCING_FACTORY = 'OUTSOURCING_FACTORY',
}
