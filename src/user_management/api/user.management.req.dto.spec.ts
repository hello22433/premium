import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UserManagementUpdateReqDto } from './user.management.req.dto';

/**
 * 계정 수정 정산 필드 계약: 정산코드 관리 페이지(wallet SoT)로 편집 이관에 따라
 * settleCondition/settleMethod/maximumLimit 는 **미전송(undefined)만 허용**하고,
 * null 은 NOT NULL 컬럼·wallet 정본 오염 방지를 위해 검증에서 거부한다(@ValidateIf).
 */
describe('UserManagementUpdateReqDto — 정산 편집 필드', () => {
  const hasError = (errs: { property: string }[], prop: string) => errs.some((e) => e.property === prop);

  async function errorsFor(body: Record<string, unknown>) {
    return validate(plainToInstance(UserManagementUpdateReqDto, body));
  }

  for (const prop of ['settleCondition', 'settleMethod', 'maximumLimit'] as const) {
    it(`${prop}: 미전송(undefined) → 해당 필드 검증 오류 없음`, async () => {
      const errs = await errorsFor({});
      expect(hasError(errs, prop)).toBe(false);
    });

    it(`${prop}: null → 검증 오류(정본/NOT NULL 오염 방지)`, async () => {
      const errs = await errorsFor({ [prop]: null });
      expect(hasError(errs, prop)).toBe(true);
    });
  }

  it('settleCondition/settleMethod: 유효 enum → 오류 없음', async () => {
    const errs = await errorsFor({ settleCondition: 'PRE_PAYMENT', settleMethod: 'CARD' });
    expect(hasError(errs, 'settleCondition')).toBe(false);
    expect(hasError(errs, 'settleMethod')).toBe(false);
  });

  it('settleMethod: 잘못된 enum 값 → 오류', async () => {
    const errs = await errorsFor({ settleMethod: 'BITCOIN' });
    expect(hasError(errs, 'settleMethod')).toBe(true);
  });

  it('maximumLimit: 숫자 → 오류 없음', async () => {
    const errs = await errorsFor({ maximumLimit: 100000 });
    expect(hasError(errs, 'maximumLimit')).toBe(false);
  });
});
