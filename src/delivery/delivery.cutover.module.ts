import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliveryWorkflowEntity } from '../entity/delivery.workflow.entity';
import { RefundAttemptEntity } from '../entity/refund.attempt.entity';
import { DeliveryCutoverGuardService } from './application/delivery-cutover-guard.service';

/**
 * 컷오버 게이트 전용 모듈 (§9 기존 경로 컷오버·마이그레이션 계약).
 *
 * legacy 진입점은 delivery·customer_service·external_api·ssg_event·partner_company_extern_history 등
 * 여러 모듈에 흩어져 있다. 가드를 `DeliveryModule` 에 두면 그 모듈들이 `DeliveryModule` 전체(발송·환불·
 * wallet 의존)를 끌어와 순환 참조가 생기므로, **의존 없는 최소 모듈**로 분리한다.
 *
 * 이 모듈은 `delivery_workflow`·`refund_attempt` 리포지토리만 필요로 하며 다른 도메인 서비스를 주입하지 않는다.
 * (`refund_attempt` 는 ledger claim 의 상위 게이트 검증에 쓴다 — §9 인벤토리 #12.)
 */
@Module({
  imports: [TypeOrmModule.forFeature([DeliveryWorkflowEntity, RefundAttemptEntity])],
  providers: [DeliveryCutoverGuardService],
  exports: [DeliveryCutoverGuardService],
})
export class DeliveryCutoverModule {}
