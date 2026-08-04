import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserDriveCreateReqDto, UserDriveUpdateReqDto } from './user.drive.req.dto';
import { IUserDriveStatus } from '../interface/user.drive.status';

/**
 * 전역 ValidationPipe({ whitelist: true, transform: true }) 가 컨트롤러 진입 시 하는 일을 그대로 재현한다.
 * (서비스 유닛테스트는 DTO 검증을 우회하므로, 첨부 개수 상한이 어느 API 에 걸리는지는 여기서만 증명된다.)
 *
 * ★ 이 스펙의 존재 이유: 등록/수정은 filePath 개수 상한과 status 필수 여부가 서로 다르다.
 *   한때 UserDriveUpdateReqDto 가 UserDriveCreateReqDto 를 상속하고 두 프로퍼티를 재선언했는데,
 *   class-validator 의 상속 중복제거는 `(propertyName, type)` 쌍으로만 동작한다
 *   (MetadataStorage.getTargetValidationMetadatas). 일반 검증기는 전부 type='customValidation' 이라
 *   재선언이 부모 것을 교체했지만 @IsOptional 만 type='conditionalValidation' 이라 살아남아,
 *   자식의 @IsNotEmpty 가 무력화됐다. 지금은 상속을 끊었고 — 아래 케이스가 그 결과를 고정한다.
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

describe('UserDriveCreateReqDto — 신규 등록은 첨부 10개 상한', () => {
  it('10개는 통과한다 (경계 안쪽)', async () => {
    expect(await validatePayload(UserDriveCreateReqDto, createPayload(files(10)))).toEqual([]);
  });

  it('11개는 거부한다 (arrayMaxSize)', async () => {
    expect(await validatePayload(UserDriveCreateReqDto, createPayload(files(11)))).toContain('arrayMaxSize');
  });

  it('첨부 0개도 통과한다 (하한은 두지 않는다 — 첨부 없는 문서가 정상 케이스)', async () => {
    expect(await validatePayload(UserDriveCreateReqDto, createPayload([]))).toEqual([]);
  });

  it('배열이 아니면 거부한다 (isArray)', async () => {
    expect(await validatePayload(UserDriveCreateReqDto, createPayload('a,b' as unknown as string[]))).toContain(
      'isArray',
    );
  });

  it('원소가 문자열이 아니면 거부한다 (isString)', async () => {
    expect(await validatePayload(UserDriveCreateReqDto, createPayload([1 as unknown as string]))).toContain('isString');
  });
});

describe('UserDriveUpdateReqDto — 수정은 첨부 개수 상한이 없다', () => {
  // ★ 리뷰 P1 회귀: 상한 도입 전(무제한 시절) 만들어진 첨부 11개↑ 문서는 FE 가 기존 목록 전체를
  //   되보내므로, update 에 상한이 살아 있으면 제목만 고쳐도 400 이 되어 영구 수정 불가해진다.
  it('11개도 통과한다 — create 의 @ArrayMaxSize(10) 이 걸리지 않음', async () => {
    expect(await validatePayload(UserDriveUpdateReqDto, updatePayload(files(11)))).toEqual([]);
  });

  it('30개(현실적 최악)도 통과한다', async () => {
    expect(await validatePayload(UserDriveUpdateReqDto, updatePayload(files(30)))).toEqual([]);
  });

  // 상한만 풀렸을 뿐 타입 검증까지 사라지면 안 된다 — 재선언한 @IsArray/@IsString 이 실제로 동작하는지.
  it('배열이 아니면 여전히 거부한다 (isArray)', async () => {
    expect(await validatePayload(UserDriveUpdateReqDto, updatePayload('a,b' as unknown as string[]))).toContain(
      'isArray',
    );
  });

  it('원소가 문자열이 아니면 여전히 거부한다 (isString)', async () => {
    expect(await validatePayload(UserDriveUpdateReqDto, updatePayload([1 as unknown as string]))).toContain('isString');
  });

  // 공통 필드는 여전히 base 에서 상속받는다 — 상속을 끊은 건 filePath/status 뿐이라는 걸 고정한다.
  it('공통 base 의 제약(receiverId @Min(1))은 그대로 적용된다', async () => {
    const broken = await validatePayload(UserDriveUpdateReqDto, { ...updatePayload(files(3)), receiverId: 0 });
    expect(broken).toContain('min');
  });

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
