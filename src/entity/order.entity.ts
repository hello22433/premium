import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { IOrderStatus } from '../order/interface/order.status';
import { UserEntity } from './user.entity';
import { OrderProductMappingEntity } from './order.product.mapping.entity';
import { BaseEntity } from '../common/entity/base.entity';
import { IOrderType } from '../order/interface/order.type';
import { OrderLikeEntity } from './order.like.entity';
import { SettleUserOrderDetailEnum } from '../settle/interface/settle.user.order.detail';
import { IUserSettleCondition } from '../user/interface/user.settle.condition';
import { CompanyType } from '../common/domain/company.type';

@Entity('order')
export class OrderEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ comment: 'FK) user.id' })
  userId: number;

  @Column({ nullable: true, comment: '운영 담당자 FK) user.id' })
  operationUserId: number | null;

  @Index()
  @Column({ nullable: true, comment: '과금 대상 담당자 FK) user.id (대행주문 시 사용)' })
  clientUserId: number | null;

  @Column({ type: 'varchar', length: 256, unique: true, comment: 'event 코드' })
  code: string;

  @Index()
  @Column({ comment: '진행 상태' })
  status: IOrderStatus;

  @Column({ comment: '타입 ex) 일반: GENERAL, 신세계: SSG , 맞춤형, 실물' })
  type: IOrderType;

  @Column({ type: 'varchar', length: 100, comment: '이벤트 명' })
  eventName: string;

  @Column({ comment: ' 등록일' })
  registerAt: Date;

  @Column({ default: 0, comment: '발송 금액' })
  sendAmount: number;

  @Column({ default: 0, comment: '정산 금액' })
  settleAmount: number;

  @Column({
    type: 'int',
    nullable: true,
    name: 'settled_amount_snapshot',
    comment: '정산확정 시점의 유효 정산금액 스냅샷 (해제 시 역방향 복원에 사용)',
  })
  settledAmountSnapshot: number | null;

  @Column({ default: 0, comment: '배송 완료 리포트 pdf 카운트' })
  deliveryCompleteReportCount: number;

  @Column({
    type: 'varchar',
    length: 20,
    nullable: true,
    comment: '마지막 배송 완료 리포트 발행 소스 ex) DOCUMENT: 문서함, DIRECT: 직접발행',
  })
  deliveryReportLastSource: string | null;

  @Column({ default: 0, comment: '거래명세서 pdf 카운트' })
  orderCompleteReportCount: number;

  @Column({
    type: 'varchar',
    length: 20,
    nullable: true,
    comment: '마지막 거래명세서 발행 소스 ex) DOCUMENT: 문서함, DIRECT: 직접발행',
  })
  transactionStatementLastSource: string | null;

  @Column({ type: 'int', nullable: true, comment: 'FK) ssg_event.id for SSG orders' })
  ssgEventId: number | null;

  @Column({ type: 'enum', enum: SettleUserOrderDetailEnum, nullable: true, comment: '정산상태 ' })
  settleStatus: SettleUserOrderDetailEnum | null;

  @Column({ default: false, comment: '정산 확정 여부' })
  isSettleComplete: boolean;

  @Column({ default: false, comment: '정산 선충전 혹은 한도 여부' })
  isSettleBalance: boolean;

  @Column({ default: true, comment: '신규 과금 흐름 적용 여부 (true: 발송확정 시 차감)' })
  isNewBillingFlow: boolean;

  @Column({ default: false, comment: '카드할증 적용 여부 (3%)' })
  cardSurchargeApplied: boolean;

  @Column({
    type: 'enum',
    enum: ['CARD', 'CASH'],
    nullable: true,
    comment: '결제수단 (CARD/CASH). 정산입력 완료 표식. NULL=미입력/레거시(읽기 시 정책 폴백)',
  })
  settleMethod: 'CARD' | 'CASH' | null;

  @Column({ default: false, comment: '신용초과발송 여부' })
  isCreditExcess: boolean;

  @Column({ type: 'text', nullable: true, comment: '주문 취소 사유' })
  cancelReason: string | null;

  @Column({ type: 'datetime', nullable: true, comment: '주문 취소 일시' })
  canceledAt: Date | null;

  // ───────────────────────────────────────────────────────────
  // 사용자/회사 정보 스냅샷 (주문 생성 시점 고정)
  // 계정관리에서 user 정보가 변경되어도 과거 주문의 거래명세서/정산은 당시 정보로 유지하기 위함.
  // 조회 시 snapshot 우선, NULL이면 user FK join 값으로 fallback.
  // ───────────────────────────────────────────────────────────

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '주문 시점의 user.personName 스냅샷' })
  snapshotPersonName: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true, comment: '주문 시점의 user.personPhoneNumber 스냅샷' })
  snapshotPersonPhone: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '주문 시점의 user.email 스냅샷' })
  snapshotEmail: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '주문 시점의 user.company.businessName 스냅샷' })
  snapshotBusinessName: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '주문 시점의 user.company.businessNumber 스냅샷' })
  snapshotBusinessNumber: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '주문 시점의 user.company.businessAddress 스냅샷' })
  snapshotBusinessAddress: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '주문 시점의 user.company.industryType 스냅샷' })
  snapshotIndustryType: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '주문 시점의 user.company.industryItem 스냅샷' })
  snapshotIndustryItem: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true, comment: '주문 시점의 user.settleCondition 스냅샷' })
  snapshotSettleCondition: IUserSettleCondition | null;

  @Column({ type: 'varchar', length: 20, nullable: true, comment: '주문 시점의 user.documentCompanyType 스냅샷' })
  snapshotDocumentCompanyType: CompanyType | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '주문 시점의 clientUser.personName 스냅샷' })
  snapshotClientPersonName: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true, comment: '주문 시점의 clientUser.personPhoneNumber 스냅샷' })
  snapshotClientPersonPhone: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '주문 시점의 clientUser.email 스냅샷' })
  snapshotClientEmail: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '주문 시점의 clientUser.company.businessName 스냅샷' })
  snapshotClientBusinessName: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '주문 시점의 clientUser.company.businessNumber 스냅샷' })
  snapshotClientBusinessNumber: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '주문 시점의 clientUser.company.businessAddress 스냅샷' })
  snapshotClientBusinessAddress: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '주문 시점의 clientUser.company.industryType 스냅샷' })
  snapshotClientIndustryType: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '주문 시점의 clientUser.company.industryItem 스냅샷' })
  snapshotClientIndustryItem: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true, comment: '주문 시점의 clientUser.settleCondition 스냅샷' })
  snapshotClientSettleCondition: IUserSettleCondition | null;

  @Column({ type: 'varchar', length: 20, nullable: true, comment: '주문 시점의 clientUser.documentCompanyType 스냅샷' })
  snapshotClientDocumentCompanyType: CompanyType | null;

  @Column({ type: 'varchar', length: 100, nullable: true, comment: '주문 시점의 operationUser.personName 스냅샷' })
  snapshotOperationPersonName: string | null;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'operation_user_id' })
  operationUser?: UserEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'client_user_id' })
  clientUser?: UserEntity;

  @OneToMany(() => OrderProductMappingEntity, (orderProductMapping) => orderProductMapping.order, {
    createForeignKeyConstraints: false,
  })
  orderProductMappings?: OrderProductMappingEntity[];

  @OneToMany(() => OrderLikeEntity, (orderLike) => orderLike.order, {
    createForeignKeyConstraints: false,
  })
  orderLikes?: OrderLikeEntity[];
}
