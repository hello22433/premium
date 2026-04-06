import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { EarlyDestroyRequestEntity, EarlyDestroyRequestStatus } from '../../entity/early.destroy.request.entity';
import { EarlyDestroyRequestItemEntity } from '../../entity/early.destroy.request.item.entity';
import { OrderEntity } from '../../entity/order.entity';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { IOrderStatus } from '../interface/order.status';
import {
  CreateEarlyDestroyRequestDto,
  EarlyDestroyRequestViewDto,
  UpdateDestroyPersonalInfoDayDto,
} from '../api/dto/early.destroy.request.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';

const DESTROY_VALUE = '-';

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
  ) {}

  @Transactional()
  async createRequest(orderId: number, dto: CreateEarlyDestroyRequestDto, user: ILoginUserInfo): Promise<EarlyDestroyRequestEntity> {
    const order = await this.orderRepository.findOne({ where: { id: orderId } });
    if (!order) {
      throw new BadRequestException('주문이 존재하지 않습니다.');
    }
    if (order.status !== IOrderStatus.DELIVERY_COMPLETE) {
      throw new BadRequestException('발송 완료된 주문만 조기파기 요청이 가능합니다.');
    }

    const mappings = await this.orderProductMappingRepository.find({
      where: { id: In(dto.orderProductMappingIds), orderId },
    });
    if (mappings.length !== dto.orderProductMappingIds.length) {
      throw new BadRequestException('유효하지 않은 상품매핑 ID가 포함되어 있습니다.');
    }

    // 이미 파기된 상품매핑 확인 (단일 쿼리)
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

    const request = this.earlyDestroyRequestRepository.create({
      orderId,
      clientCompany: dto.clientCompany ?? null,
      contactPerson: dto.contactPerson ?? null,
      contactEmail: dto.contactEmail ?? null,
      salesReceipt: dto.salesReceipt ?? null,
      eventName: dto.eventName ?? null,
      productInfo: dto.productInfo ?? null,
      specialNotes: dto.specialNotes ?? null,
      desiredCompletionDate: dto.desiredCompletionDate ? new Date(dto.desiredCompletionDate) : null,
      referenceNotes: dto.referenceNotes ?? null,
      status: EarlyDestroyRequestStatus.PENDING,
      requestedBy: user.id,
      requestedAt: new Date(),
    });

    const savedRequest = await this.earlyDestroyRequestRepository.save(request);

    const items = dto.orderProductMappingIds.map((mappingId) =>
      this.earlyDestroyRequestItemRepository.create({
        earlyDestroyRequestId: savedRequest.id,
        orderProductMappingId: mappingId,
      }),
    );
    await this.earlyDestroyRequestItemRepository.save(items);

    return savedRequest;
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

    const mappingIds = request.items.map((item) => item.orderProductMappingId);

    // 파기 UPDATE + 상태 UPDATE 병렬 실행
    await Promise.all([
      this.orderDeliveryRepository
        .createQueryBuilder()
        .update(OrderDeliveryEntity)
        .set({ deliveryTarget: DESTROY_VALUE, originalDeliveryTarget: DESTROY_VALUE })
        .where('orderProductMappingId IN (:...ids)', { ids: mappingIds })
        .andWhere('(deliveryTarget != :v OR originalDeliveryTarget != :v)', { v: DESTROY_VALUE })
        .execute(),
      this.earlyDestroyRequestRepository.update(requestId, {
        status: EarlyDestroyRequestStatus.COMPLETED,
        executedBy: user.id,
        executedAt: new Date(),
      }),
    ]);

    this.logger.log(`조기파기 실행 완료: requestId=${requestId}, executedBy=${user.email}`);
  }

  async updateDestroyPersonalInfoDay(orderProductMappingId: number, dto: UpdateDestroyPersonalInfoDayDto): Promise<void> {
    const result = await this.orderProductMappingRepository.update(orderProductMappingId, {
      requestToDestroyPersonalInfoDay: dto.requestToDestroyPersonalInfoDay,
    });

    if (result.affected === 0) {
      throw new BadRequestException('상품매핑이 존재하지 않습니다.');
    }
  }
}
