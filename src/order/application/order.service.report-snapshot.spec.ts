/**
 * T2 snapshot test: document builders use snapshot price/name, not LIVE product.
 *
 * Strategy: test at the readLineProductView seam directly — the exact calc expression
 * introduced in getOrderCompleteReport / getOrderCompleteReportMultiple / getUserDetail /
 * getUserDetailMultipleByOrderIds is:
 *
 *   const lineView = readLineProductView(orderProductMapping);
 *   const originalPrice = lineView.price;
 *   let adjustedPrice = originalPrice;
 *   if (fee > 0 && priceAdjustment) { adjustedPrice = OrderFeeCalculator({ fee, priceAdjustment, price: originalPrice }); }
 *   // D3-49: 인라인 ceil → 실제 차감과 동일한 OrderFeeCalculator(반올림)로 통일됨. 본 헬퍼도 동기화.
 *
 * We verify that when snapshotProductPrice=1000 and product.price=1500,
 * readLineProductView returns price=1000, so the calc yields unitPrice=1000
 * (no fee) and lineTotal=2000 for amount=2.  If code used product.price instead
 * it would yield 1500 / 3000 — catching a regression.
 */

import { readLineProductView } from '../util/order.snapshot.builder';
import { OrderProductMappingEntity } from '../../entity/order.product.mapping.entity';
import { IPriceAdjustment } from '../../user_discount/interface/price.adjustment';
import { OrderFeeCalculator } from '../domain/order.fee.calculator';

// Minimal OPM factory — only fields readLineProductView and the fee calc use
function makeOpm(overrides: Partial<OrderProductMappingEntity>): OrderProductMappingEntity {
  return {
    snapshotProductPrice: null,
    snapshotProductName: null,
    snapshotProductBrandName: null,
    snapshotProductExpireDay: null,
    snapshotProductImagePath: null,
    product: undefined,
    fee: null,
    priceAdjustment: null,
    amount: 1,
    ...overrides,
  } as unknown as OrderProductMappingEntity;
}

// Replicate the exact fee calc used in the document builders.
function calcAdjustedPrice(opm: OrderProductMappingEntity): number {
  const lineView = readLineProductView(opm);
  const originalPrice = lineView.price;
  // D3-49: 문서/정산 빌더가 인라인 ceil → OrderFeeCalculator(반올림, 실제 차감과 동일)로 통일. 본 헬퍼도 동기화.
  return opm.fee !== null && opm.fee > 0 && opm.priceAdjustment
    ? OrderFeeCalculator({ fee: opm.fee, priceAdjustment: opm.priceAdjustment, price: originalPrice })
    : originalPrice;
}

describe('readLineProductView — snapshot price takes precedence over LIVE product.price', () => {
  it('returns snapshot price when both snapshot and live product exist', () => {
    const opm = makeOpm({
      snapshotProductPrice: 1000,
      product: { price: 1500, name: 'LIVE', brand: null, expireDay: 30, imagePath: null } as any,
    });

    const view = readLineProductView(opm);
    expect(view.price).toBe(1000); // snapshot price wins over live 1500
    // snapshotProductName is null so name falls back to live product.name — that is correct behavior
    expect(view.name).toBe('LIVE');
  });

  it('document calc: unitPrice=1000, lineTotal=2000 for amount=2, no fee', () => {
    const opm = makeOpm({
      snapshotProductPrice: 1000,
      snapshotProductName: 'SNAP',
      product: { price: 1500, name: 'LIVE', brand: null, expireDay: 0, imagePath: null } as any,
      amount: 2,
    });

    const unitPrice = calcAdjustedPrice(opm);
    const lineTotal = unitPrice * opm.amount;

    expect(unitPrice).toBe(1000); // NOT 1500
    expect(lineTotal).toBe(2000); // NOT 3000
  });

  it('document calc with 10% discount fee uses snapshot base, not live base', () => {
    // snapshot=1000, live=1500, fee=10% discount → 1000 - round(10%·1000)=100 = 900 (100단위라 ceil==round)
    const opm = makeOpm({
      snapshotProductPrice: 1000,
      product: { price: 1500, name: 'LIVE', brand: null, expireDay: 0, imagePath: null } as any,
      fee: 10,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      amount: 2,
    });

    const unitPrice = calcAdjustedPrice(opm);
    expect(unitPrice).toBe(900); // 1000-100=900, live base였다면 1350
    expect(unitPrice * opm.amount).toBe(1800); // NOT 2700
  });

  it('D3-49: 비100 단가는 반올림(실제 차감)과 일치 — 이전 올림(ceil)과 1원 다름', () => {
    // snapshot=3335, fee=10% discount
    //   이전(ceil):  Math.ceil(3335*90/100)=ceil(3001.5)=3002
    //   현행(round, OrderFeeCalculator): 3335 - round(333.5)=334 = 3001  ← 실제 차감액과 동일
    const opm = makeOpm({
      snapshotProductPrice: 3335,
      fee: 10,
      priceAdjustment: IPriceAdjustment.DISCOUNT,
      amount: 1,
    });

    expect(calcAdjustedPrice(opm)).toBe(3001);
  });

  it('falls back to live product.price when snapshot is null', () => {
    const opm = makeOpm({
      snapshotProductPrice: null,
      product: { price: 1500, name: 'LIVE', brand: null, expireDay: 0, imagePath: null } as any,
    });

    const view = readLineProductView(opm);
    expect(view.price).toBe(1500);
  });

  it('returns 0 and deleted-product name when both snapshot and product are absent', () => {
    const opm = makeOpm({
      snapshotProductPrice: null,
      snapshotProductName: null,
      product: undefined,
    });

    const view = readLineProductView(opm);
    expect(view.price).toBe(0);
    expect(view.name).toBe('(삭제된 상품)');
  });

  it('snapshot name used over live product name', () => {
    const opm = makeOpm({
      snapshotProductName: 'SNAPSHOT_NAME',
      product: { price: 0, name: 'LIVE_NAME', brand: null, expireDay: 0, imagePath: null } as any,
    });

    const view = readLineProductView(opm);
    expect(view.name).toBe('SNAPSHOT_NAME');
  });
});
