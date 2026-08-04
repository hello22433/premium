import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserDriveCreateReqDto, UserDriveUpdateReqDto } from './user.drive.req.dto';
import { IUserDriveStatus } from '../interface/user.drive.status';

/**
 * 전역 ValidationPipe({ whitelist: true, transform: true }) 가 컨트롤러 진입 시 하는 일을 그대로 재현한다.
 * (서비스 유닛테스트는 DTO 검증을 우회하므로, 첨부 개수 상한이 어느 API 에 걸리는지는 여기서만 증명된다.)
 *
 * ★ 이 스펙의 존재 이유: 등록/수정은 filePath 규칙이 같고 status 규칙이 다르다. 그 경계가 코드에
 *   보이지 않아 한 번 사고가 났다 — UpdateReqDto 가 CreateReqDto 를 상속하고 status 를 재선언했는데,
 *   class-validator 의 상속 중복제거가 `(propertyName, type)` 쌍으로만 동작하는 탓에
 *   (MetadataStorage.getTargetValidationMetadatas) 일반 검증기(type='customValidation')는 교체됐지만
 *   @IsOptional(type='conditionalValidation')만 살아남아 자식의 @IsNotEmpty 가 무력화됐다.
 *   지금은 공통 규칙만 base 가 갖고 다른 규칙은 각 DTO 가 직접 선언한다 — 아래가 그 경계를 고정한다.
 */
async function validatePayload<T extends object>(cls: new () => T, payload: unknown): Promise<string[]> {
  const instance = plainToInstance(cls, payload, { enableImplicitConversion: false });
  const errors = await validate(instance as object, { whitelist: true, forbidUnknownValues: false });
  const flatten = (errs: typeof errors): string[] =>
    errs.flatMap((e) => [...Object.keys(e.constraints ?? {}), ...flatten(e.children ?? [])]);
  return flatten(errors);
}

const files = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `https://bucket.s3.ap-northeast-2.amazonaws.com/private/5/uuid-${i}.png`);

const createPayload = (filePath: string[]) => ({
  receiverId: 2,
  title: '제목',
  content: '내용',
  filePath,
});

const updatePayload = (filePath: string[]) => ({
  id: 10,
  receiverId: 2,
  title: '제목',
  content: '내용',
  status: IUserDriveStatus.REGISTER,
  filePath,
});

// ★ 첨부 규칙은 등록/수정이 같아야 한다 — 한쪽만 고치는 회귀를 막으려고 같은 표를 양쪽에 돌린다.
//   과거엔 수정만 상한이 없었다(상한 도입 전 문서의 영구 수정 불가를 피하려던 임시 조치).
//   운영 DB 실측(2026-08-04)에서 첨부 11개↑ 문서 0건 / 최대 2개로 확인돼 상한을 통일했다.
describe.each([
  ['UserDriveCreateReqDto', UserDriveCreateReqDto, createPayload],
  ['UserDriveUpdateReqDto', UserDriveUpdateReqDto, updatePayload],
] as const)('%s — 첨부 규칙은 등록/수정 공통', (_name, Dto, payload) => {
  it('10개는 통과한다 (경계 안쪽)', async () => {
    expect(await validatePayload(Dto, payload(files(10)))).toEqual([]);
  });

  it('11개는 거부한다 (arrayMaxSize)', async () => {
    expect(await validatePayload(Dto, payload(files(11)))).toContain('arrayMaxSize');
  });

  it('첨부 0개도 통과한다 (하한은 두지 않는다 — 첨부 없는 문서가 정상 케이스)', async () => {
    expect(await validatePayload(Dto, payload([]))).toEqual([]);
  });

  it('배열이 아니면 거부한다 (isArray)', async () => {
    expect(await validatePayload(Dto, payload('a,b' as unknown as string[]))).toContain('isArray');
  });

  it('원소가 문자열이 아니면 거부한다 (isString)', async () => {
    expect(await validatePayload(Dto, payload([1 as unknown as string]))).toContain('isString');
  });

  it('공통 base 의 제약(receiverId @Min(1))이 적용된다', async () => {
    expect(await validatePayload(Dto, { ...payload(files(3)), receiverId: 0 })).toContain('min');
  });
});

describe('UserDriveUpdateReqDto — status 는 수정에서 필수', () => {
  // ★ 상속 시절의 실제 구멍: create 의 @IsOptional(conditionalValidation) 이 교체되지 않고 남아
  //   status 생략/null 이 검증을 통째로 건너뛰었다. status 컬럼은 NOT NULL 이라 null 은 저장 단계
  //   에러가 되고, 생략은 TypeORM 이 undefined 를 무시해 "필수 필드가 조용히 무시" 됐다.
  it('status 를 생략하면 거부한다', async () => {
    const { status: _status, ...withoutStatus } = updatePayload(files(3));
    expect(await validatePayload(UserDriveUpdateReqDto, withoutStatus)).toContain('isNotEmpty');
  });

  it('status 가 null 이면 거부한다 (NOT NULL 컬럼이 저장 단계에서 터지기 전에)', async () => {
    expect(await validatePayload(UserDriveUpdateReqDto, { ...updatePayload(files(3)), status: null })).toContain(
      'isNotEmpty',
    );
  });

  it('status 가 enum 밖 값이면 거부한다', async () => {
    expect(await validatePayload(UserDriveUpdateReqDto, { ...updatePayload(files(3)), status: 'NOPE' })).toContain(
      'isEnum',
    );
  });
});

describe('UserDriveCreateReqDto — status 는 등록에서 선택(기본 REGISTER)', () => {
  // 위 수정 규칙을 강화하면서 등록의 "선택" 성질까지 같이 조이면 임시저장 흐름이 깨진다.
  it('status 를 생략해도 통과한다', async () => {
    const { filePath, ...rest } = createPayload(files(2));
    expect(await validatePayload(UserDriveCreateReqDto, { ...rest, filePath })).toEqual([]);
  });

  it('status 가 enum 밖 값이면 거부한다 (선택이지 무검증은 아니다)', async () => {
    expect(await validatePayload(UserDriveCreateReqDto, { ...createPayload(files(2)), status: 'NOPE' })).toContain(
      'isEnum',
    );
  });
});
