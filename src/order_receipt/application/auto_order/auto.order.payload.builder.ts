import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { IOrderSendMethod } from '../../../order/interface/order.send.method';
import { OrderEmailSendType } from '../../../order/domain/order.email.send.type';
import { OrderProductCreateTempDto, OrderDeliveryCreateDto } from '../../../order/api/dto/order.product.create.temp.dto';
import { BuildPayloadInput, BuildPayloadResult, MappedRow, ParsedHeader, resolveDeliveryTarget } from './auto.order.types';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * 5단계 - payload 조립.
 * 4단계에서 차단된 행을 제거한 뒤 createTemp가 먹는 DTO를 만든다.
 * → 차단 행이 빠졌으므로 createTemp는 금칙어/수량 등으로 throw하지 않는다.
 *
 * 리뷰 반영: 수량(amount)은 J셀을 신뢰하지 않고 "살아남은 행 수"로 계산한다
 * (이메일 전용 행은 B(휴대폰)가 비어 J=0이 될 수 있으므로).
 */
@Injectable()
export class AutoOrderPayloadBuilder {
  /** @returns 남은 수신자 0명이면 null(= 주문 안 만듦) */
  build(input: BuildPayloadInput): BuildPayloadResult | null {
    const { header, rows, orderType, blockedRowNos } = input;
    const isEmail = header.sendMethod === IOrderSendMethod.EMAIL;

    // 차단 행 제거 + 이 발신수단으로 실제 보낼 수신처가 있는 행만
    const usableRows = rows.filter(
      (r) => !blockedRowNos.has(r.rowNo) && resolveDeliveryTarget(header.sendMethod, r) !== null,
    );
    if (usableRows.length === 0) return null;

    // 같은 상품끼리 묶기(엑셀 등장 순서 보존)
    const byProductId = new Map<number, MappedRow[]>();
    for (const row of usableRows) {
      const list = byProductId.get(row.product.id) ?? [];
      list.push(row);
      byProductId.set(row.product.id, list);
    }

    const sendType = header.isImmediate ? 'IMMEDIATE' : 'RESERVE';
    const sendRequestAt = header.isImmediate ? null : this.toKstString(header.sendRequestAt);

    const orderProductList: OrderProductCreateTempDto[] = [...byProductId.entries()].map(([productId, group]) => ({
      productId,
      amount: group.length, // ★ 행 수 기반(J 신뢰 안 함)
      sendMethod: header.sendMethod,
      sendTitle: header.sendTitle,
      sendContent: header.sendContent,
      fromPhoneNumber: header.fromPhoneNumber,
      requestToDestroyPersonalInfoDay: header.destroyDay,
      sendType,
      sendRequestAt,
      sendTailText: null,
      // EMAIL이면 발신주소(등록/기본계정 주입)+발송타입 URL 기본. 그 외 채널은 미사용(null).
      fromEmail: isEmail ? (input.fromEmail ?? null) : null,
      emailSendType: isEmail ? OrderEmailSendType.URL : null,
      useEmailContent: null,
      encourageDay: null,
      orderDeliveryList: group.map((r) => this.toDelivery(header.sendMethod, r)),
    }));

    const payload: BuildPayloadResult['payload'] = {
      type: orderType,
      eventName: header.eventName,
      orderProductList,
    };

    // 리포트용 상품 분해(그룹은 최소 1행이라 group[0].product 안전)
    const products = [...byProductId.entries()].map(([productId, group]) => ({
      productId,
      productName: group[0].product.name,
      code: group[0].product.code,
      faceValue: group[0].product.price,
      deliveryCount: group.length,
    }));

    return { payload, sourceRowNos: usableRows.map((r) => r.rowNo), products };
  }

  private toDelivery(sendMethod: IOrderSendMethod | null, row: MappedRow): OrderDeliveryCreateDto {
    return {
      deliveryTarget: resolveDeliveryTarget(sendMethod, row)!, // usableRows 필터로 non-null 보장
      replaceCharacter1: row.replaceCharacter1 ?? undefined,
      replaceCharacter2: row.replaceCharacter2 ?? undefined,
      replaceCharacter3: row.replaceCharacter3 ?? undefined,
    };
  }

  /** KST Date → 'YYYY-MM-DDTHH:mm:ss'(dateAtRegexp 준수, KST 벽시계) */
  private toKstString(date: Date | null): string | null {
    if (!date) return null;
    return dayjs(date).tz('Asia/Seoul').format('YYYY-MM-DDTHH:mm:ss');
  }
}
