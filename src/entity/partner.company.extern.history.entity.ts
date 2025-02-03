import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';
import { IPartnerCompanyType } from '../partner_company/interface/partner.company.type';

@Entity('partner_company_extern_history')
export class PartnerCompanyExternHistoryEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'text', comment: '연동 history' })
  context: string;

  @Column({ comment: '성공 여부 ' })
  isSuccess: boolean;

  @Column({
    type: 'enum',
    enum: IPartnerCompanyType,
  })
  type: IPartnerCompanyType;
}
