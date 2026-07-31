import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { EarlyDestroyRequestEntity, EarlyDestroyRequestStatus } from '../../entity/early.destroy.request.entity';
import { EarlyDestroyRequestItemEntity } from '../../entity/early.destroy.request.item.entity';
import { OrderEntity } from '../../entity/order.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { OrderHistoryEntity } from '../../entity/order.history.entity';
import { OrderDeliveryRefundStatusEnum } from '../../delivery/interface/order.delivery.refund.status.enum';
import { IOrderStatus } from '../interface/order.status';
import {
  CreateDeliveriesEarlyDestroyRequestDto,
  CreateDeliveryEarlyDestroyRequestDto,
  CreateEarlyDestroyRequestDto,
  CreateWholeOrderEarlyDestroyRequestDto,
  EarlyDestroyRequestMetaDto,
  EarlyDestroyRequestViewDto,
  UpdateDestroyPersonalInfoDayDto,
} from '../api/dto/early.destroy.request.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
// PII 보유 history type 단일 소스(정기파기 배치와 공유). 재export 로 기존 import 경로 호환 유지.
import { PII_BEARING_HISTORY_TYPES } from '../interface/order.history.pii.types';

export { PII_BEARING_HISTORY_TYPES };

const DESTROY_VALUE = '-';
const REFUND_IN_PROGRESS_MESSAGE = '환불 진행 중인 건으로 파기 실패했습니다. 고객센터(1644-3614)로 문의해주세요.';

type RequestItemSeed = Pick<EarlyDestroyRequestItemEntity, 'orderProductMappingId' | 'orderDeliveryId'>;

@Injectable()
export class EarlyDestroyService {
  private readonly logger = new Logger(EarlyDestroyService.name);

  constructor(
    @InjectRepository(EarlyDestroyRequestEntity)
    private earlyDestroyRequestRepository: Repository<EarlyDestroyRequestEntity>,
    @InjectRepository(EarlyDestroyRequestItemEntity)
    private earlyDestroyRequestItemRepository: Repository<EarlyDestroyRequestItemEntity>,
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderProductMappingEntity)
    private orderProductMappingRepository: Repository<OrderProductMappingEntity>,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(OrderHistoryEntity)
    private orderHistoryRepository: Repository<OrderHistoryEntity>,
  ) {}

  @Transactional()
  async createRequest(
    orderId: number,
    dto: CreateEarlyDestroyRequestDto,
    user: ILoginUserInfo,
  ): Promise<EarlyDestroyRequestEntity> {
    await this.assertOrderDeliveryComplete(orderId);

    const mappings = await this.orderProductMappingRepository.find({
      where: { id: In(dto.orderProductMappingIds), orderId },
    });
    if (mappings.length !== dto.orderProductMappingIds.length) {
      throw new BadRequestException('유효하지 않은 상품매핑 ID가 포함되어 있습니다.');
    }

    const nonDestroyedCounts = await this.orderDeliveryRepository
      .createQueryBuilder('od')
      .select('od.orderProductMappingId', 'mappingId')
      .addSelect('COUNT(od.id)', 'cnt')
      .where('od.orderProductMappingId IN (:...ids)', { ids: dto.orderProductMappingIds })
      .andWhere('(od.deliveryTarget != :v OR od.originalDeliveryTarget != :v)', { v: DESTROY_VALUE })
      .groupBy('od.orderProductMappingId')
      .getRawMany<{ mappingId: number; cnt: string }>();

    const hasNonDestroyedIds = new Set(nonDestroyedCounts.map((r) => Number(r.mappingId)));
    for (const mapping of mappings) {
      if (!hasNonDestroyedIds.has(mapping.id)) {
        throw new BadRequestException(`상품매핑 ID ${mapping.id}은 이미 파기가 완료되었습니다.`);
      }
    }

    await this.assertNoPendingDuplicate(orderId, { mappingIds: dto.orderProductMappingIds });

    return this.saveRequest(
      orderId,
      dto,
      user,
      dto.orderProductMappingIds.map((mappingId) => ({
        orderProductMappingId: mappingId,
        orderDeliveryId: null,
      })),
    );
  }

  @Transactional()
  async createRequestForOrder(
    orderId: number,
    dto: CreateWholeOrderEarlyDestroyRequestDto,
    user: ILoginUserInfo,
  ): Promise<EarlyDestroyRequestEntity> {
    await this.assertOrderDeliveryComplete(orderId);

    const mappings = await this.orderProductMappingRepository.find({ where: { orderId } });
    if (mappings.length === 0) {
      throw new BadRequestException('해당 주문에 상품매핑이 없습니다.');
    }

    const mappingIds = mappings.map((m) => m.id);
    const nonDestroyedCount = await this.orderDeliveryRepository
      .createQueryBuilder('od')
      .where('od.orderProductMappingId IN (:...ids)', { ids: mappingIds })
      .andWhere('(od.deliveryTarget != :v OR od.originalDeliveryTarget != :v)', { v: DESTROY_VALUE })
      .getCount();
    if (nonDestroyedCount === 0) {
      throw new BadRequestException('해당 주문은 이미 모든 발송건이 파기되었습니다.');
    }

    await this.assertNoPendingDuplicate(orderId, { mappingIds });

    return this.saveRequest(
      orderId,
      dto,
      user,
      mappings.map((m) => ({
        orderProductMappingId: m.id,
        orderDeliveryId: null,
      })),
    );
  }

  async createRequestForDelivery(
    dto: CreateDeliveryEarlyDestroyRequestDto,
    user: ILoginUserInfo,
  ): Promise<EarlyDestroyRequestEntity> {
    const { orderDeliveryId, ...meta } = dto;
    return this.createRequestForDeliveries(
      { ...meta, orderDeliveryIds: [orderDeliveryId] } as CreateDeliveriesEarlyDestroyRequestDto,
      user,
    );
  }

  @Transactional()
  async createRequestForDeliveries(
    dto: CreateDeliveriesEarlyDestroyRequestDto,
    user: ILoginUserInfo,
  ): Promise<EarlyDestroyRequestEntity> {
    const uniqueIds = Array.from(new Set(dto.orderDeliveryIds));
    if (uniqueIds.length === 0) {
      throw new BadRequestException('발송건 ID가 비어 있습니다.');
    }

    const deliveries = await this.orderDeliveryRepository.find({
      where: { id: In(uniqueIds) },
      relations: ['orderProductMapping'],
    });
    if (deliveries.length !== uniqueIds.length) {
      throw new BadRequestException('유효하지 않은 발송건 ID가 포함되어 있습니다.');
    }

    const orderIds = new Set(deliveries.map((d) => d.orderProductMapping.orderId));
    if (orderIds.size > 1) {
      throw new BadRequestException('서로 다른 주문의 발송건은 한 번에 파기할 수 없습니다.');
    }
    const orderId = deliveries[0].orderProductMapping.orderId;

    await this.assertOrderDeliveryComplete(orderId);

    const alreadyDestroyed = deliveries.filter(
      (d) => d.deliveryTarget === DESTROY_VALUE && d.originalDeliveryTarget === DESTROY_VALUE,
    );
    if (alreadyDestroyed.length > 0) {
      throw new BadRequestException(
        `이미 파기된 발송건이 포함되어 있습니다. (id: ${alreadyDestroyed.map((d) => d.id).join(', ')})`,
      );
    }

    await this.assertNoPendingDuplicate(orderId, {
      deliveries: deliveries.map((d) => ({ id: d.id, mappingId: d.orderProductMappingId })),
    });

    return this.saveRequest(
      orderId,
      dto,
      user,
      deliveries.map((d) => ({
        orderProductMappingId: d.orderProductMappingId,
        orderDeliveryId: d.id,
      })),
    );
  }

  async getRequests(orderId: number): Promise<EarlyDestroyRequestViewDto[]> {
    const requests = await this.earlyDestroyRequestRepository.find({
      where: { orderId },
      relations: ['requestedByUser', 'executedByUser', 'items'],
      order: { createdAt: 'DESC' },
    });

    return requests.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      clientCompany: r.clientCompany,
      contactPerson: r.contactPerson,
      contactEmail: r.contactEmail,
      salesReceipt: r.salesReceipt,
      eventName: r.eventName,
      productInfo: r.productInfo,
      specialNotes: r.specialNotes,
      desiredCompletionDate: r.desiredCompletionDate,
      referenceNotes: r.referenceNotes,
      status: r.status,
      requestedBy: r.requestedBy,
      requestedByEmail: r.requestedByUser?.email ?? null,
      requestedAt: r.requestedAt,
      executedBy: r.executedBy,
      executedByEmail: r.executedByUser?.email ?? null,
      executedAt: r.executedAt,
      orderProductMappingIds: r.items.map((item) => item.orderProductMappingId),
      orderDeliveryIds: r.items.map((item) => item.orderDeliveryId).filter((id): id is number => id !== null),
    }));
  }

  @Transactional()
  async executeRequest(requestId: number, user: ILoginUserInfo): Promise<void> {
    const request = await this.earlyDestroyRequestRepository.findOne({
      where: { id: requestId },
      relations: ['items'],
    });

    if (!request) {
      throw new BadRequestException('조기파기 요청이 존재하지 않습니다.');
    }
    if (request.status !== EarlyDestroyRequestStatus.PENDING) {
      throw new BadRequestException('대기 중인 요청만 실행할 수 있습니다.');
    }

    // M-2 하드닝: 실행 시점에 주문 상태를 재검증한다. 등록~실행 사이 상태가 바뀐 경우(예: 발송취소)
    // 방어. (이중 실행은 위 PENDING 가드가 차단하므로 멱등 측면은 충분)
    await this.assertOrderDeliveryComplete(request.orderId);

    const targetDeliveryIds: number[] = [];
    const targetMappingIds: number[] = [];
    for (const item of request.items) {
      if (item.orderDeliveryId !== null) {
        targetDeliveryIds.push(item.orderDeliveryId);
      } else {
        targetMappingIds.push(item.orderProductMappingId);
      }
    }

    const affectedDeliveryIds = [...targetDeliveryIds];
    if (targetMappingIds.length > 0) {
      const mappingDeliveries = await this.orderDeliveryRepository.find({
        where: { orderProductMappingId: In(targetMappingIds) },
        select: ['id'],
      });
      affectedDeliveryIds.push(...mappingDeliveries.map((d) => d.id));
    }

    if (affectedDeliveryIds.length > 0) {
      const inProgressCount = await this.orderDeliveryRepository.count({
        where: {
          id: In(affectedDeliveryIds),
          refundStatus: In([OrderDeliveryRefundStatusEnum.PROGRESS, OrderDeliveryRefundStatusEnum.APPROVE]),
        },
      });
      if (inProgressCount > 0) {
        throw new BadRequestException(REFUND_IN_PROGRESS_MESSAGE);
      }
    }

    // 파기 실행 시각. 아래 PII 마스킹과 request.executedAt 각인에 **같은 값**을 쓴다 — 각자
    // new Date() 를 부르면 요청서(executedAt)와 발송건(destroyedAt)이 몇 밀리초 어긋나고,
    // 그 둘을 대조하는 감사에서 불필요한 노이즈가 된다.
    const destroyedAt = new Date();

    // ★ destroyedAt 은 이 payload 에 넣지 않는다. 이 UPDATE 는 매핑 단위(orderProductMappingId
    //   IN ...)로도 실행되는데, 매핑 지정/주문 전체 요청은 **미파기 발송건이 하나라도 있으면
    //   통과**하므로(createRequest / createRequestForOrder) 이미 파기된 형제 행까지 범위에 들어온다.
    //   payload 에 섞으면 그 형제의 파기일이 무조건 덮이고, 그중에는 **정기파기로 지운 실적**이
    //   섞여 있을 수 있다. 그러면 정기파기 실적이 조기파기 실적으로 위조된다.
    //   유효기간 가드가 같은 주문 안에서 발송건별 파기 시점을 갈라놓으므로 흔한 조합이다.
    const piiPayload = {
      deliveryTarget: DESTROY_VALUE,
      originalDeliveryTarget: DESTROY_VALUE,
      emailReceiverPhone: DESTROY_VALUE,
      bankAccount: DESTROY_VALUE,
      bankAccountOwner: DESTROY_VALUE,
    };

    // 각인 대상 판정은 **마스킹 이전 상태**로 해야 하므로 UPDATE 전에 읽는다.
    // 규칙은 정기파기 배치와 동일하다(delivery.batch.service.ts 참조):
    //  · 아직 각인된 적 없음        → 각인
    //  · 각인돼 있는데 수신처가 살아있음(= CS 수신정보 변경으로 부활) → 새 시각으로 갱신
    //  · 각인돼 있고 이미 '-'        → 최초 파기일 유지 (재실행이어도 PII 는 그때 사라졌다)
    // 마지막 항목이 백필 SQL 의 MIN(executed_at) 규칙과 같은 뜻이다 — 같은 컬럼에 두 규칙이
    // 공존하면 감사자가 이 값을 어떻게 읽어야 할지 정의되지 않는다.
    // 재실행 사실 자체는 early_destroy_request 가 요청별로 보존하므로 여기서 덮을 이유가 없다.
    const stampTargets = await this.orderDeliveryRepository.find({
      where: { id: In(affectedDeliveryIds) },
      select: ['id', 'destroyedAt', 'deliveryTarget'],
      withDeleted: true,
    });
    const stampIdList = stampTargets
      .filter((d) => d.destroyedAt === null || d.deliveryTarget !== DESTROY_VALUE)
      .map((d) => d.id);

    const deliveryUpdateConditions: Array<[string, number[]]> = [];
    if (targetDeliveryIds.length > 0) deliveryUpdateConditions.push(['id', targetDeliveryIds]);
    if (targetMappingIds.length > 0) deliveryUpdateConditions.push(['orderProductMappingId', targetMappingIds]);
    for (const [column, ids] of deliveryUpdateConditions) {
      await this.orderDeliveryRepository
        .createQueryBuilder()
        .update(OrderDeliveryEntity)
        .set(piiPayload)
        .where(`${column} IN (:...ids)`, { ids })
        .execute();
    }

    if (stampIdList.length > 0) {
      await this.orderDeliveryRepository
        .createQueryBuilder()
        .update(OrderDeliveryEntity)
        .set({ destroyedAt })
        .where('id IN (:...ids)', { ids: stampIdList })
        .execute();
    }
    const keptCount = affectedDeliveryIds.length - stampIdList.length;
    if (keptCount > 0) {
      // 이미 파기돼 있던 형제 행을 다시 덮은 경우. 정상 동작(요청이 매핑 단위였다)이지만,
      // 그 행의 파기일이 이번 요청서(executedAt)와 불일치하게 되므로 감사 대조 시 필요하다.
      this.logger.log(
        `[조기파기] 이미 파기된 발송건 ${keptCount}건은 최초 파기일을 유지함 — requestId=${requestId}. ` +
          `해당 건의 destroyed_at 은 이 요청의 executedAt 과 다를 수 있다(정상).`,
      );
    }

    if (affectedDeliveryIds.length > 0) {
      // order_history 의 PII 는 PII_BEARING_HISTORY_TYPES(수신정보 변경요청/폐기 후 신규 발송)의
      // beforeChange/afterChange 에만 존재한다. 폐기/환불폐기/핀상태 변경 이력의 before/after 는
      // couponStatus 전이 감사값이므로 type 필터 없이 전 행을 덮으면 상태 감사기록이 파괴된다(C-1).
      await this.orderHistoryRepository
        .createQueryBuilder()
        .update(OrderHistoryEntity)
        .set({ beforeChange: DESTROY_VALUE, afterChange: DESTROY_VALUE })
        .where('orderDeliveryId IN (:...ids)', { ids: affectedDeliveryIds })
        .andWhere('type IN (:...piiTypes)', { piiTypes: [...PII_BEARING_HISTORY_TYPES] })
        .execute();
    }

    await this.earlyDestroyRequestRepository.update(requestId, {
      status: EarlyDestroyRequestStatus.COMPLETED,
      executedBy: user.id,
      // 발송건에 각인한 destroyedAt 과 동일한 값(위 참조). 요청서 단위 기록과 발송건 단위 기록이
      // 같은 시각을 가리켜야 감사 시 두 테이블을 대조할 수 있다.
      executedAt: destroyedAt,
    });

    this.logger.log(
      `조기파기 실행 완료: requestId=${requestId}, deliveries=${affectedDeliveryIds.length}, executedBy=${user.email}`,
    );
  }

  async updateDestroyPersonalInfoDay(
    orderProductMappingId: number,
    dto: UpdateDestroyPersonalInfoDayDto,
  ): Promise<void> {
    const result = await this.orderProductMappingRepository.update(orderProductMappingId, {
      requestToDestroyPersonalInfoDay: dto.requestToDestroyPersonalInfoDay,
    });

    if (result.affected === 0) {
      throw new BadRequestException('상품매핑이 존재하지 않습니다.');
    }
  }

  private async assertOrderDeliveryComplete(orderId: number): Promise<void> {
    const order = await this.orderRepository.findOne({ where: { id: orderId } });
    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }
    if (order.status !== IOrderStatus.DELIVERY_COMPLETE) {
      throw new BadRequestException('발송 완료된 주문만 조기파기 요청이 가능합니다.');
    }
  }

  /**
   * 미완료(PENDING) 요청과 **완전히 중복**(새 요청의 모든 대상이 이미 대기 중)인 경우만 거부(L-1).
   * 더 넓은 범위(상위집합) 신규는 허용한다 — 발송건 1건만 대기 중인데 그 매핑 전체를 새로 파기하려는
   * 경우, 나머지 발송건을 파기해야 하므로 막지 않는다("물건 하나 때문에 상자 전체 파기 불가"는 모순).
   *  - 매핑 전체 신규: 그 매핑이 이미 "전체"로 대기 중일 때만 거부.
   *  - 발송건 신규: 같은 발송건이 대기 중이거나, 그 발송건의 매핑 전체가 대기 중이면 거부.
   */
  private async assertNoPendingDuplicate(
    orderId: number,
    targets: { mappingIds?: number[]; deliveries?: { id: number; mappingId: number }[] },
  ): Promise<void> {
    const pending = await this.earlyDestroyRequestRepository.find({
      where: { orderId, status: EarlyDestroyRequestStatus.PENDING },
      relations: ['items'],
    });
    if (pending.length === 0) return;

    const pendingWholeMappingIds = new Set<number>(); // orderDeliveryId IS NULL = 매핑 전체 파기 대기
    const pendingDeliveryIds = new Set<number>(); // 특정 발송건 파기 대기
    for (const req of pending) {
      for (const item of req.items) {
        if (item.orderDeliveryId !== null) pendingDeliveryIds.add(item.orderDeliveryId);
        else pendingWholeMappingIds.add(item.orderProductMappingId);
      }
    }

    // 완전 중복일 때만 거부 = 요청한 대상이 "모두"(every) 이미 대기 중인 경우.
    // 하나라도 신규 대상이 있으면 그 대상 파기를 위해 등록을 허용한다(일부 겹침은 통과).
    const mappingIds = targets.mappingIds ?? [];
    if (mappingIds.length > 0 && mappingIds.every((m) => pendingWholeMappingIds.has(m))) {
      throw new BadRequestException('요청한 상품매핑이 모두 이미 대기 중인 조기파기 요청에 포함되어 있습니다.');
    }
    // 발송건은 "같은 발송건이 대기" 또는 "그 발송건의 매핑 전체가 대기"면 이미 덮인 것으로 본다.
    const deliveries = targets.deliveries ?? [];
    if (
      deliveries.length > 0 &&
      deliveries.every((d) => pendingDeliveryIds.has(d.id) || pendingWholeMappingIds.has(d.mappingId))
    ) {
      throw new BadRequestException('요청한 발송건이 모두 이미 대기 중인 조기파기 요청에 포함되어 있습니다.');
    }
  }

  private async saveRequest(
    orderId: number,
    meta: EarlyDestroyRequestMetaDto,
    user: ILoginUserInfo,
    items: RequestItemSeed[],
  ): Promise<EarlyDestroyRequestEntity> {
    const request = this.earlyDestroyRequestRepository.create({
      orderId,
      clientCompany: meta.clientCompany ?? null,
      contactPerson: meta.contactPerson ?? null,
      contactEmail: meta.contactEmail ?? null,
      salesReceipt: meta.salesReceipt ?? null,
      eventName: meta.eventName ?? null,
      productInfo: meta.productInfo ?? null,
      specialNotes: meta.specialNotes ?? null,
      desiredCompletionDate: meta.desiredCompletionDate ? new Date(meta.desiredCompletionDate) : null,
      referenceNotes: meta.referenceNotes ?? null,
      status: EarlyDestroyRequestStatus.PENDING,
      requestedBy: user.id,
      requestedAt: new Date(),
    });

    const savedRequest = await this.earlyDestroyRequestRepository.save(request);

    const itemEntities = items.map((seed) =>
      this.earlyDestroyRequestItemRepository.create({
        earlyDestroyRequestId: savedRequest.id,
        orderProductMappingId: seed.orderProductMappingId,
        orderDeliveryId: seed.orderDeliveryId,
      }),
    );
    await this.earlyDestroyRequestItemRepository.save(itemEntities);

    return savedRequest;
  }
}
