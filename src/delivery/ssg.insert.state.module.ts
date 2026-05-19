import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { OrderDeliverySsgInsertStateEntity } from '../entity/order.delivery.ssg.insert.state.entity';
import { SsgIssueLogEntity } from '../entity/ssg.issue.log.entity';
import { SsgInsertStateService } from './application/ssg-insert-state.service';

/**
 * SsgInsertStateService 단독 모듈.
 * plans/ssg-balance-refactor.md PR2.
 *
 * DeliveryModule 과 PartnerCompanyExternModule 양쪽에서 사용해야 하는데,
 * DeliveryModule → PartnerCompanyExternModule 단방향 import 가 이미 존재한다.
 * 역방향을 추가하면 순환 의존이 발생하므로 SsgInsertStateService 만 별 가벼운 모듈로 분리해
 * 두 도메인 모두 의존성 없이 import 가능하게 한다.
 *
 * 서비스 파일은 위치 변경 부담을 피하려고 src/delivery/application 에 그대로 두었다.
 * 서비스 자체는 SSG INSERT durable state 신호만 다루며 delivery 로직에 의존하지 않는다.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrderDeliveryEntity,
      OrderDeliverySsgInsertStateEntity,
      SsgIssueLogEntity,
    ]),
  ],
  providers: [SsgInsertStateService],
  exports: [SsgInsertStateService],
})
export class SsgInsertStateModule {}
