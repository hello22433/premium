import { OrderPrefixCode, OrderDigitNumber, createTempOrderCode, deriveOrderCodeFromId } from './order.code';

describe('order.code id 파생 채번 (D3-51)', () => {
  describe('deriveOrderCodeFromId', () => {
    it('id 를 EPEVT + 11자리 zero-pad 로 변환한다', () => {
      expect(deriveOrderCodeFromId(1)).toBe('EPEVT00000000001');
      expect(deriveOrderCodeFromId(5620)).toBe('EPEVT00000005620');
    });

    it('11자리 미만은 앞을 0으로 채운다', () => {
      expect(deriveOrderCodeFromId(290)).toBe(`${OrderPrefixCode}00000000290`);
      expect(deriveOrderCodeFromId(1234567890)).toBe(`${OrderPrefixCode}01234567890`);
    });

    it('생성된 코드 길이는 접두어 + 자릿수와 같다', () => {
      expect(deriveOrderCodeFromId(42)).toHaveLength(OrderPrefixCode.length + OrderDigitNumber);
    });

    it('서로 다른 id 는 서로 다른 코드를 만든다(유일성)', () => {
      expect(deriveOrderCodeFromId(100)).not.toBe(deriveOrderCodeFromId(101));
    });

    it('11자리 경계값은 정상 처리한다', () => {
      expect(deriveOrderCodeFromId(99999999999)).toBe(`${OrderPrefixCode}99999999999`);
    });

    it('id 가 11자리를 초과하면 throw 한다(불변식 보호)', () => {
      expect(() => deriveOrderCodeFromId(100000000000)).toThrow(/초과/);
    });

    it('지수표기 대상 거대값도 문자열길이 우회 없이 throw 한다(F2)', () => {
      // String(1e21) === '1e+21'(길이 5) → 문자열 길이 판정이면 통과해버리는 케이스
      expect(() => deriveOrderCodeFromId(1e21)).toThrow(/안전정수|초과/);
      expect(() => deriveOrderCodeFromId(Number.MAX_SAFE_INTEGER)).toThrow(/초과/);
    });

    it('id 가 양의 안전정수가 아니면 throw 한다', () => {
      expect(() => deriveOrderCodeFromId(0)).toThrow(/양의 안전정수/);
      expect(() => deriveOrderCodeFromId(-1)).toThrow(/양의 안전정수/);
      expect(() => deriveOrderCodeFromId(1.5)).toThrow(/양의 안전정수/);
      expect(() => deriveOrderCodeFromId(NaN)).toThrow(/양의 안전정수/);
      expect(() => deriveOrderCodeFromId(Infinity)).toThrow(/양의 안전정수/);
    });
  });

  describe('createTempOrderCode', () => {
    it("'TMP-' 접두어를 가진다", () => {
      expect(createTempOrderCode().startsWith('TMP-')).toBe(true);
    });

    it('확정코드 접두어(EPEVT)와 겹치지 않는다', () => {
      expect(createTempOrderCode().startsWith(OrderPrefixCode)).toBe(false);
    });

    it('호출마다 유일한 값을 만든다(동시 INSERT 충돌 방지)', () => {
      const codes = new Set(Array.from({ length: 1000 }, () => createTempOrderCode()));
      expect(codes.size).toBe(1000);
    });
  });
});
