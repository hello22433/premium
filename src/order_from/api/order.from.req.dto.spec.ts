import { plainToInstance } from 'class-transformer';
import { OrderFromGetPhoneReqQueryDto } from './order.from.req.dto';

/**
 * P0 회귀 잠금 — 빈 user 쿼리(`?userId=`) 변환.
 *
 * 프론트 self 모드는 `?userId=`(빈 문자열)을 전송한다.
 * `@Type(() => Number)` + ValidationPipe(transform:true) 조합은 `Number('')` => 0 으로
 * 변환해, 서비스의 `getQuery.userId ?? user.id` 가 0 을 흘려 본인 조회를 깨뜨렸다.
 * 빈 문자열/공백은 undefined 로 떨어져야 `?? user.id` 가 정상 동작한다.
 */
describe('OrderFromGetPhoneReqQueryDto — 빈 userId 변환 (P0)', () => {
  const transform = (raw: unknown) =>
    plainToInstance(OrderFromGetPhoneReqQueryDto, { userId: raw });

  it('빈 문자열 userId 는 undefined 로 변환한다 (0 이 아님)', () => {
    expect(transform('').userId).toBeUndefined();
  });

  it('공백 문자열 userId 는 undefined 로 변환한다', () => {
    expect(transform('   ').userId).toBeUndefined();
  });

  it('정상 숫자 문자열은 number 로 변환한다', () => {
    expect(transform('22').userId).toBe(22);
  });

  it('미전달(undefined)은 undefined 를 유지한다', () => {
    expect(plainToInstance(OrderFromGetPhoneReqQueryDto, {}).userId).toBeUndefined();
  });
});
