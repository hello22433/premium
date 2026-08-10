import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { InventoryPinBillingChainEntity } from '../../entity/inventory.pin.billing.chain.entity';
import { PinInventoryOrderResponseDto } from '../interface/inventory.pin.external.dto';
import { DirectPinFulfillmentStatus } from '../domain/inventory.pin.status';

/**
 * 외부 API 재고형 쿠폰 주문 서비스. rev5 §11.4.
 *
 * - PIN-free 전용 DTO/응답
 * - root trId로 조회, current owner 상태 반환
 * - (apiAppId, externalOrderId) UNIQUE 멱등
 */
@Injectable()
export class InventoryPinExternalService {
  private readonly logger = new Logger(InventoryPinExternalService.name);

  constructor(
    @InjectRepository(OrderDeliveryEntity)
    private readonly deliveryRepo: Repository<OrderDeliveryEntity>,
    @InjectRepository(InventoryPinBillingChainEntity)
    private readonly chainRepo: Repository<InventoryPinBillingChainEntity>,
  ) {}

  async getOrderStatus(apiAppId: string, trId: string): Promise<PinInventoryOrderResponseDto> {
    // apiAppId scope: externalTrId → delivery → mapping → order → order.apiAppId 검증
    const delivery = await this.deliveryRepo.findOne({
      where: { externalTrId: trId },
      relations: ['orderProductMapping', 'orderProductMapping.order'],
    });

    if (!delivery) {
      throw new NotFoundException('order not found');
    }

    // tenant 격리: order.apiAppId가 호출자의 apiAppId와 일치해야 함
    const order = delivery.orderProductMapping?.order;
    if (!order || String(order.apiAppId) !== apiAppId) {
      throw new NotFoundException('order not found');
    }

    // 빌링 체인으로 current owner 해석
    if (delivery.inventoryPinBillingChainId) {
      const chain = await this.chainRepo.findOne({
        where: { id: delivery.inventoryPinBillingChainId },
      });
      if (chain && Number(chain.currentOrderDeliveryId) !== delivery.id) {
        const currentDelivery = await this.deliveryRepo.findOne({
          where: { id: Number(chain.currentOrderDeliveryId) },
        });
        if (currentDelivery) {
          return this.buildResponseFromCurrent(currentDelivery, trId, delivery);
        }
      }
    }

    return this.buildResponse(delivery);
  }

  private buildResponse(delivery: OrderDeliveryEntity): PinInventoryOrderResponseDto {
    return {
      trId: delivery.externalTrId || '',
      externalOrderId: delivery.externalTrId || '',
      status: this.mapFulfillmentToExternal(delivery.directPinFulfillmentStatus, delivery),
      productCode: '', // resolved from mapping
      faceValueAmount: '', // resolved from config
      currencyCode: '', // resolved from config
      validEndDate: delivery.expireAt?.toISOString().slice(0, 10),
    };
  }

  private buildResponseFromCurrent(
    currentDelivery: OrderDeliveryEntity,
    rootTrId: string,
    rootDelivery: OrderDeliveryEntity,
  ): PinInventoryOrderResponseDto {
    return {
      trId: rootTrId,
      externalOrderId: rootTrId,
      status: this.mapFulfillmentToExternal(currentDelivery.directPinFulfillmentStatus, currentDelivery),
      productCode: '',
      faceValueAmount: '',
      currencyCode: '',
      validEndDate: currentDelivery.expireAt?.toISOString().slice(0, 10),
    };
  }

  /**
   * 내부 fulfillment → 외부 API 상태 매핑. rev5 §11.4.
   */
  private mapFulfillmentToExternal(
    fulfillment: DirectPinFulfillmentStatus | null,
    delivery: OrderDeliveryEntity,
  ): 'PENDING' | 'SENT' | 'FAILED' | 'UNKNOWN' | 'CANCELLED' {
    switch (fulfillment) {
      case 'PENDING_SEND':
      case 'SENDING':
        return 'PENDING';
      case 'SENT':
        return 'SENT';
      case 'FAILED':
        return 'FAILED';
      case 'UNKNOWN':
        return 'UNKNOWN';
      case 'VOID':
        // VOID + REFUNDED → CANCELLED
        return 'CANCELLED';
      default:
        return 'PENDING';
    }
  }
}