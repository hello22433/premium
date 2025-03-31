import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { OtherServiceSaleProductMappingEntity } from './other.service.sale.product.mapping.entity';
import { UserEntity } from './user.entity';
import { OtherServiceSaleTypeEntity } from './other.service.sale.type.entity';
import { ShippingStorageEntity } from './shipping.storage.entity';

@Entity('other_service_sale')
export class OtherServiceSaleEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', comment: 'FK) 담당자 id' })
  userId: number;

  @Column({ type: 'int', comment: 'FK) 고객사 id' })
  businessUserId: number;

  @Column({ type: 'int', comment: 'FK) 출하창고 id' })
  shippingStorageId: number;

  @Column({ type: 'int', comment: 'FK) 판매유형 id' })
  saleTypeId: number;

  @Column({ type: 'boolean', comment: '부가세 적용 여부 ex) true: 적용' })
  isVat: boolean;

  @Column({ type: 'varchar', comment: '이벤트 명' })
  eventName: string;

  @Column({ type: 'date', comment: '증빙 일자 ex) yyyy-MM-dd' })
  proveAt: Date;

  @Column({ type: 'varchar', comment: '이벤트 상세정보' })
  eventContent: string;

  @Column({ type: 'varchar', nullable: true, comment: '특이사항' })
  etc: string | null;

  // 고객사 user
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'business_user_id' })
  businessUser: UserEntity;

  // 담당자 user
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @ManyToOne(() => OtherServiceSaleTypeEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'sale_type_id' })
  saleType: OtherServiceSaleTypeEntity;

  @ManyToOne(() => ShippingStorageEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'shipping_storage_id' })
  shippingStorage: ShippingStorageEntity;

  @OneToMany(
    () => OtherServiceSaleProductMappingEntity,
    (otherServiceSaleProductMapping) => otherServiceSaleProductMapping.otherServiceSale,
    {
      createForeignKeyConstraints: false,
    },
  )
  otherServiceSaleProductMappings: OtherServiceSaleProductMappingEntity[];
}
