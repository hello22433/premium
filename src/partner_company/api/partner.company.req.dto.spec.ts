import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PartnerCompanyGetListReqQueryDto } from './partner.company.req.dto';

/**
 * 전역 ValidationPipe({ whitelist: true, transform: true }) 가 컨트롤러 진입 시 하는 일을 그대로 재현한다.
 * (서비스 유닛테스트는 DTO 검증을 우회하므로, searchType 값 허용/거부는 여기서만 증명된다.)
 */
async function validatePayload<T extends object>(cls: new () => T, payload: unknown): Promise<string[]> {
  const instance = plainToInstance(cls, payload, { enableImplicitConversion: false });
  const errors = await validate(instance as object, { whitelist: true, forbidUnknownValues: false });
  const flatten = (errs: typeof errors): string[] =>
    errs.flatMap((e) => [...Object.keys(e.constraints ?? {}), ...flatten(e.children ?? [])]);
  return flatten(errors);
}

describe('PartnerCompanyGetListReqQueryDto searchType 검증', () => {
  const allowed = ['ALL', 'email', 'businessName', 'personName', 'personPhoneNumber'];

  it.each(allowed)('searchType=%s 는 통과한다', async (searchType) => {
    expect(await validatePayload(PartnerCompanyGetListReqQueryDto, { page: 1, take: 10, searchType })).toEqual([]);
  });

  it('서비스 switch 가 지원하는 personPhoneNumber 가 DTO validation 을 통과한다', async () => {
    const errors = await validatePayload(PartnerCompanyGetListReqQueryDto, {
      page: 1,
      take: 10,
      searchType: 'personPhoneNumber',
      searchKeyword: '010',
    });
    expect(errors).toEqual([]);
  });

  it('지원하지 않는 searchType 은 거부한다 (IsIn → 400)', async () => {
    expect(
      await validatePayload(PartnerCompanyGetListReqQueryDto, { page: 1, take: 10, searchType: 'unknown' }),
    ).toContain('isIn');
  });

  it('searchType 미전달은 통과한다 (IsOptional)', async () => {
    expect(await validatePayload(PartnerCompanyGetListReqQueryDto, { page: 1, take: 10 })).toEqual([]);
  });
});
