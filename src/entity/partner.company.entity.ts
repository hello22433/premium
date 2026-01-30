import { BaseEntity } from '../common/entity/base.entity';
import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { IPartnerCompanySettleCondition } from '../partner_company/interface/partner.company.settle.condition';
import { IPartnerCompanySettleMethod } from '../partner_company/interface/partner.company.settle.method';
import { IPartnerCompanyStatus } from '../partner_company/interface/partner.company.status';
import { IPartnerCompanyType } from '../partner_company/interface/partner.company.type';
import { UserDiscountEntity } from './user.discount.entity';

@Entity('partner_company')
export class PartnerCompanyEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 100, unique: true, comment: '코드' })
  code: string;

  @Column({
    type: 'varchar',
    nullable: true,
    length: 100,
    comment: '법인 등록 번호',
  })
  corporateNumber: string | null;

  @Column({ type: 'varchar', length: 100, comment: '사업자 등록 번호' })
  businessNumber: string;

  @Column({ type: 'varchar', length: 100, comment: '사업자명' })
  businessName: string;

  @Column({ type: 'varchar', length: 100, comment: '사업자 주소' })
  businessAddress: string;

  @Column({ type: 'varchar', length: 100, comment: '사업자 연락처' })
  businessPhoneNumber: string;

  @Column({ type: 'varchar', length: 100, comment: '담당자 이름' })
  personName: string;

  @Column({ type: 'varchar', length: 20, comment: '담당자 연락처' })
  personPhoneNumber: string;

  @Column({ type: 'varchar', length: 100, comment: '담당자 이메일' })
  personEmail: string;

  @Column({ type: 'varchar', length: 100, comment: '정산 조건 ex) 선정산 : PRE_PAYMENT, 후정산: POST_PAYMENT' })
  settleCondition: IPartnerCompanySettleCondition;

  @Column({ comment: '정산 일' })
  settleDay: number;

  @Column({ type: 'varchar', length: 100, comment: '정산 방법 ex) 카드: CARD, 현금: CASH' })
  settleMethod: IPartnerCompanySettleMethod;

  @Column({ comment: '최대 서비스 한도 가격' })
  maximumLimit: number;

  @Column({ type: 'varchar', length: 100, comment: '은행 명' })
  bankName: string;

  @Column({ type: 'varchar', length: 100, comment: '계좌 번호' })
  bankNumber: string;

  @Column({ type: 'varchar', length: 100, default: 'ACTIVE', comment: 'ex) 정상: ACTIVE' })
  status: IPartnerCompanyStatus;

  @Column({
    type: 'boolean',
    comment: '유효기간 계산 시 발송 다음날부터 계산할지 여부 (true: 다음날, false: 발송일 포함)',
    default: true,
  })
  validityStartsNextDay: boolean;

  @Column({
    type: 'enum',
    enum: IPartnerCompanyType,
    nullable: true,
  })
  type: IPartnerCompanyType | null;

  @OneToMany(() => UserDiscountEntity, (userDiscount) => userDiscount.partnerCompany, {
    createForeignKeyConstraints: false,
  })
  userDiscounts?: UserDiscountEntity[];
}
