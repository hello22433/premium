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
