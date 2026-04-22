/**
 * Giftiel push 응답 DTO
 *
 * Giftiel "교환정보전송가이드 - 1.2 응답 정보" 규격
 */
export class GiftielExchangeResDto {
  result_code: '0000' | '9999';
  result_msg: string;
  ServCode: string;
  TrID: string;
  DateTime: string;
}
