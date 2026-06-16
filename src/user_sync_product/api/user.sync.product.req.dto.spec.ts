import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserSyncProductGetListReqDto, UserSyncProductRegisterEventReqDto } from './user.sync.product.req.dto';

/**
 * user_sync_product 입력 DTO 검증 회귀 테스트 (audit #45 userId, #46 입력검증 일관성).
 *
 * - #45: registerEvent userId 에 @IsNotEmpty/@Min(1) 부재 → 0/누락 통과하던 결함.
 * - #46: getList businessUserName/code/name 에 @IsString 비대칭,
 *        registerEvent email/phone/name/code 포맷 검증 부재.
 */
const hasError = async (dto: object, property: string): Promise<boolean> => {
  const errors = await validate(dto);
  return errors.some((e) => e.property === property);
};

describe('UserSyncProductGetListReqDto 입력검증 (#46)', () => {
  it.each(['businessUserName', 'code', 'name'])('%s 는 문자열이 아니면 거부된다', async (prop) => {
    const dto = plainToInstance(UserSyncProductGetListReqDto, { [prop]: 12345 });
    expect(await hasError(dto, prop)).toBe(true);
  });

  it('정상 문자열은 통과한다', async () => {
    const dto = plainToInstance(UserSyncProductGetListReqDto, {
      businessUserName: '고객사',
      code: 'EVT-1',
      name: '이벤트',
    });
    expect(await hasError(dto, 'businessUserName')).toBe(false);
    expect(await hasError(dto, 'code')).toBe(false);
    expect(await hasError(dto, 'name')).toBe(false);
  });
});

describe('UserSyncProductRegisterEventReqDto 입력검증 (#45/#46)', () => {
  const valid = {
    userId: 1,
    userPersonName: '담당자',
    name: '이벤트',
    code: 'EVT-1',
    status: 'ACTIVE',
    phone: '01012345678',
    email: 'user@test.com',
  };

  it('정상 입력은 에러가 없다', async () => {
    const dto = plainToInstance(UserSyncProductRegisterEventReqDto, valid);
    expect(await validate(dto)).toHaveLength(0);
  });

  it('userId 0 은 거부된다 (#45 @Min(1))', async () => {
    const dto = plainToInstance(UserSyncProductRegisterEventReqDto, { ...valid, userId: 0 });
    expect(await hasError(dto, 'userId')).toBe(true);
  });

  it('잘못된 email 형식은 거부된다 (#46 @IsEmail)', async () => {
    const dto = plainToInstance(UserSyncProductRegisterEventReqDto, { ...valid, email: 'not-an-email' });
    expect(await hasError(dto, 'email')).toBe(true);
  });

  it('하이픈 포함 phone 은 통과한다 (저장 포맷 호환)', async () => {
    const dto = plainToInstance(UserSyncProductRegisterEventReqDto, { ...valid, phone: '010-1234-5678' });
    expect(await hasError(dto, 'phone')).toBe(false);
  });

  it('문자가 섞인 phone 은 거부된다 (#46 @Matches)', async () => {
    const dto = plainToInstance(UserSyncProductRegisterEventReqDto, { ...valid, phone: '010abc5678' });
    expect(await hasError(dto, 'phone')).toBe(true);
  });

  it.each(['name', 'code'])('%s 는 문자열이 아니면 거부된다 (#46 @IsString)', async (prop) => {
    const dto = plainToInstance(UserSyncProductRegisterEventReqDto, { ...valid, [prop]: 999 });
    expect(await hasError(dto, prop)).toBe(true);
  });
});
