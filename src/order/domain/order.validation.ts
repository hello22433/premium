import { OrderEntity } from '../../entity/order.entity';
import { BadRequestException } from '@nestjs/common';
import { IOrderSendMethod } from '../interface/order.send.method';
import { IOrderStatus } from '../interface/order.status';
import { IOrderType } from '../interface/order.type';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

type SsgReservationCandidate = {
  sendType?: string | null;
  sendRequestAt?: string | Date | null;
};

export type SsgReservationRangeBoundary = {
  startDate: Date;
  endDate: Date;
};

export const validateSsgReservationWindow = (
  type: IOrderType | null | undefined,
  products: SsgReservationCandidate[],
  range?: SsgReservationRangeBoundary | null,
) => {
  if (type !== IOrderType.SSG) return;

  // range 설정 있음: 그 범위 내 검증
  // range 설정 없음(폴백): 기존 당월 검증
  const rangeStartKst = range ? dayjs.tz(range.startDate, 'Asia/Seoul').startOf('day') : null;
  const rangeEndKst = range ? dayjs.tz(range.endDate, 'Asia/Seoul').endOf('day') : null;
  const monthEndKst = dayjs().tz('Asia/Seoul').endOf('month');

  for (const product of products) {
    if (product.sendType !== 'RESERVE' || !product.sendRequestAt) continue;

    const sendAt = dayjs.tz(product.sendRequestAt, 'Asia/Seoul');

    if (range) {
      if (sendAt.isBefore(rangeStartKst) || sendAt.isAfter(rangeEndKst)) {
        const startStr = rangeStartKst!.format('YYYY-MM-DD');
        const endStr = rangeEndKst!.format('YYYY-MM-DD');
        throw new BadRequestException(`예약발송은 ${startStr} ~ ${endStr} 범위 내에서만 가능합니다.`);
      }
    } else {
      if (sendAt.isAfter(monthEndKst)) {
        throw new BadRequestException('예약발송은 이번 달 내에서만 가능합니다.');
      }
    }
  }
};

/**
 * SSG 주문 내 모든 mapping(상품 행)의 발송 유형/예약시각이 동일한지 검증한다.
 * - 전체 즉시발송: 허용 (mapping별 저장 시각 밀리초 차이는 비교하지 않음)
 * - 전체 예약발송이며 sendRequestAt 동일: 허용
 * - 즉시/예약 혼합 또는 서로 다른 예약시각: 400
 * sendType 미선택(임시저장 draft) 행은 검사 대상에서 제외한다.
 */
export const validateSsgUniformSend = (type: IOrderType | null | undefined, products: SsgReservationCandidate[]) => {
  if (type !== IOrderType.SSG) return;

  const hasImmediate = products.some((p) => p.sendType === 'IMMEDIATE');
  const reserveProducts = products.filter((p) => p.sendType === 'RESERVE');

  if (hasImmediate && reserveProducts.length > 0) {
    throw new BadRequestException('SSG 주문은 즉시발송과 예약발송을 혼합할 수 없습니다.');
  }

  if (reserveProducts.length > 0) {
    const reserveTimes = new Set(reserveProducts.map((p) => new Date(p.sendRequestAt as string | Date).getTime()));
    if (reserveTimes.size > 1) {
      throw new BadRequestException('SSG 주문의 예약 발송 시간은 모든 상품 행에서 동일해야 합니다.');
    }
  }
};

/**
 * 발송요청(실발송) 시점에 모든 상품 행의 발송 방식이 확정됐는지 검증한다.
 * 임시저장 단계에서는 sendType 미선택(draft)을 허용하지만, 실제 발송요청/잔액 차감
 * 직전에는 모든 행이 유효한 sendType을 가져야 하며 RESERVE 행은 sendRequestAt이 필수다.
 * (특히 SSG는 발송요청 시 행사 잔액이 즉시 차감되므로 null sendType 행을 막아야 함)
 */
export const validateDeliverySendTypes = (products: SsgReservationCandidate[]) => {
  for (const product of products) {
    if (product.sendType !== 'IMMEDIATE' && product.sendType !== 'RESERVE') {
      throw new BadRequestException('발송 방식(즉시/예약)이 지정되지 않은 상품이 있습니다.');
    }
    if (product.sendType === 'RESERVE' && !product.sendRequestAt) {
      throw new BadRequestException('예약 발송 상품에는 발송 요청 시각이 필요합니다.');
    }
  }
};

/**
 * 중복 수신번호 제한을 productId 단위로 결정한다 (§3.3.5/3.3.9).
 * 같은 productId를 여러 mapping(상품 행)으로 나눠도 가장 엄격한 유한 제한을 적용한다.
 *  - ADDITIONAL(할증)/DISCOUNT(할인, 임시 비활성화): 무제한 후보 → 제한에 기여하지 않음
 *  - 할인/할증 없음: duplicatePhoneLimit (0이면 무제한)
 * 같은 productId의 유한 후보 중 최솟값을 그룹 제한으로 반환한다.
 * 유한 후보가 하나도 없으면(모두 무제한) 해당 productId는 맵에서 제외(= 검사 생략).
 * 단, 유한 제한이 존재하는 productId의 무제한 mapping 배송건도 호출부에서 합산 대상에 포함해야 한다.
 */
export const resolveProductDuplicateLimit = (
  mappings: { id: number; productId: number }[],
  priceAdjustments: Map<number, IPriceAdjustment | null>,
  duplicatePhoneLimit: number,
): Map<number, number> => {
  const productLimit = new Map<number, number>();
  // 0이면 전체 무제한 — mapping 순회 불필요
  if (duplicatePhoneLimit === 0) return productLimit;

  for (const mapping of mappings) {
    const priceAdjustment = priceAdjustments.get(mapping.id);
    const isUnlimited =
      priceAdjustment === IPriceAdjustment.ADDITIONAL || priceAdjustment === IPriceAdjustment.DISCOUNT;
    if (isUnlimited) continue;
    const prev = productLimit.get(mapping.productId);
    productLimit.set(mapping.productId, prev === undefined ? duplicatePhoneLimit : Math.min(prev, duplicatePhoneLimit));
  }
  return productLimit;
};

export const OrderValidation = (order: OrderEntity) => {
  // let now = new Date();
  // now = addMinutes(now, 30);

  if (!order.eventName) {
    throw new BadRequestException('이벤트 명이 존재하지 않습니다.');
  }

  // if (order.sendRequestAt < now) {
  //   throw new BadRequestException('발송 요청 시각이 현재시각 보다 30분 전으로 입력 바랍니다.');
  // }

  for (const orderProduct of order.orderProductMappings!) {
    // 각 상품별 제목/내용 검증
    if (!orderProduct.sendTitle) {
      throw new BadRequestException('제목이 존재하지 않습니다.');
    }

    if (!orderProduct.sendContent) {
      throw new BadRequestException('내용이 존재하지 않습니다.');
    }

    if (orderProduct.amount !== orderProduct.orderDeliveries.length) {
      throw new BadRequestException('상품 전송과 전송 주체의 개수가 같지 않습니다.');
    }

    if (order.status !== IOrderStatus.DELIVERY_REQUEST) {
      if (orderProduct.product.useStatus !== 'USE') {
        throw new BadRequestException('사용할 수 없는 상품이 존재합니다.');
      }
    }

    // 각 상품별 발송 방법 검증
    const sendMethod = orderProduct.sendMethod;
    if (sendMethod === IOrderSendMethod.MMS || sendMethod === IOrderSendMethod.ALIM_TALK) {
      if (!orderProduct.fromPhoneNumber) {
        throw new BadRequestException('발신 번호를 입력해 주세요.');
      }
    }

    if (sendMethod === IOrderSendMethod.EMAIL) {
      if (!orderProduct.fromEmail) {
        throw new BadRequestException('발신 이메일을 입력해 주세요.');
      }

      if (!orderProduct.emailSendType) {
        throw new BadRequestException('QR 혹은 URL을 선택해주세요.');
      }
    }
  }

  return;
};
