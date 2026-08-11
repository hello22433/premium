import { BadRequestException } from '@nestjs/common';
import { ProductEntity } from '../../entity/product.entity';
import {
  buildLineProductSnapshot,
  buildPartnerSettleSnapshot,
  LineProductSnapshotPart,
  PartnerSettleSnapshotPart,
} from '../util/order.snapshot.builder';

export type OwnedLine = {
  productId: number;
  testDeliveryCount: number;
  snapshot?: LineProductSnapshotPart;
  partnerSettleSnapshot?: PartnerSettleSnapshotPart;
};

/**
 * 승계 대상 라인 id. 상품이 교체된 라인은 이력·한도가 이전 상품 것이라 승계하지 않는다.
 * 승계 대입과 고아 정리가 같은 판정을 써야 "승계했는데 고아로 지운다"가 생기지 않는다.
 */
export function resolveCarriedLineId(
  line: { id?: number; productId: number },
  owned: Map<number, OwnedLine>,
): number | null {
  if (line.id == null) return null;
  return owned.get(line.id)?.productId === line.productId ? line.id : null;
}

export function assertLineIdsValid(lines: { id?: number; productId: number }[], owned: Map<number, OwnedLine>): void {
  const seen = new Set<number>();
  for (const line of lines) {
    if (line.id == null) continue;
    if (!owned.has(line.id)) {
      throw new BadRequestException('해당 주문에 속하지 않는 상품 행입니다.');
    }
    if (seen.has(line.id)) {
      throw new BadRequestException('동일 상품 행 ID가 중복 전달되었습니다.');
    }
    seen.add(line.id);
  }
}

export function resolveLineSnapshot(
  line: { id?: number; productId: number },
  owned: Map<number, OwnedLine>,
  liveProduct: ProductEntity,
) {
  if (line.id != null) {
    const prev = owned.get(line.id);
    if (prev?.productId === line.productId && prev.snapshot) {
      return prev.snapshot;
    }
  }
  return buildLineProductSnapshot(liveProduct);
}

export function resolvePartnerSettleSnapshot(
  line: { id?: number; productId: number },
  owned: Map<number, OwnedLine>,
  liveProduct: ProductEntity,
  price: number,
): PartnerSettleSnapshotPart {
  if (line.id != null) {
    const prev = owned.get(line.id);
    if (prev?.productId === line.productId && prev.partnerSettleSnapshot) {
      return prev.partnerSettleSnapshot;
    }
  }
  return buildPartnerSettleSnapshot(liveProduct, price);
}
