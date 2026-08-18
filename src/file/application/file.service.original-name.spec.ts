import { FileService } from './file.service';

/**
 * 다운로드 프록시가 쓰는 원본 파일명 복원 회귀 테스트.
 * DB에 파일명 컬럼이 없는 도메인(주문접수)은 S3 key 의 `{무작위식별자}-{원본명}` 에서
 * 첫 '-' 뒤를 원본명으로 복원한다. 신키(private/uuid)·구키(file/Date.now) 모두 호환되어야 한다.
 */
describe('FileService.extractOriginalFileName — key 에서 원본명 복원', () => {
  const sut = new FileService({} as any);

  it('신키(private/{32hex}-원본) → 원본명', () => {
    const url = 'https://b.s3.amazonaws.com/private/0123456789abcdef0123456789abcdef-보고서.xlsx';
    expect(sut.extractOriginalFileName(url)).toBe('보고서.xlsx');
  });

  it('구키(file/{Date.now}-원본) → 원본명 (레거시 호환)', () => {
    const url = 'https://b.s3.amazonaws.com/file/1780551879605-주문서.xlsx';
    expect(sut.extractOriginalFileName(url)).toBe('주문서.xlsx');
  });

  it('원본명에 하이픈이 있어도 보존', () => {
    const url = 'https://b.s3.amazonaws.com/private/0123456789abcdef0123456789abcdef-2024-01-주문.xlsx';
    expect(sut.extractOriginalFileName(url)).toBe('2024-01-주문.xlsx');
  });

  it('URL 인코딩된 한글 파일명 디코드', () => {
    const url =
      'https://b.s3.amazonaws.com/private/0123456789abcdef0123456789abcdef-' + encodeURIComponent('정산내역.xlsx');
    expect(sut.extractOriginalFileName(url)).toBe('정산내역.xlsx');
  });
});

/**
 * getOriginalName 의 catch 회귀.
 *
 * 이 catch 는 원래 '메타데이터 조회 실패 → key 폴백' 을 아무 로그 없이 삼켰다. 그러면 IAM 권한 상실·
 * 버킷 오설정·자격증명 만료로 원본명 기능이 통째로 꺼져도 응답은 200 이고 로그가 0줄이라 아무도 모른다
 * (화면엔 sanitize 된 이름이 나와 "이름이 좀 이상한데요" CS 만 남는다).
 * 객체가 없는 것(NotFound/NoSuchKey)만 정상 폴백으로 조용히 넘기고 나머지는 남긴다.
 */
describe('FileService.getOriginalName — 메타데이터 조회 실패 처리', () => {
  const url = 'https://b.s3.amazonaws.com/private/5/0123456789abcdef-해지 신청서.pdf';

  const makeSut = (headImpl: jest.Mock) => {
    const sut = new FileService({ headOriginalName: headImpl } as any);
    (sut as any).logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    return sut;
  };

  it('메타데이터가 있으면 그 값을 그대로 쓴다', async () => {
    const sut = makeSut(jest.fn().mockResolvedValue('해지 신청서.pdf'));
    expect(await sut.getOriginalName(url)).toBe('해지 신청서.pdf');
    expect((sut as any).logger.warn).not.toHaveBeenCalled();
  });

  it('객체 없음(NotFound) → 조용히 key 복원 (레거시 첨부의 정상 폴백)', async () => {
    const sut = makeSut(jest.fn().mockRejectedValue(Object.assign(new Error('nf'), { name: 'NotFound' })));
    expect(await sut.getOriginalName(url)).toBe('해지 신청서.pdf');
    expect((sut as any).logger.warn).not.toHaveBeenCalled();
  });

  // ★ 이게 없으면 warn 을 지워도 초록이다.
  it('★권한 상실(AccessDenied) → key 복원 + 경고 1회 (조용히 죽지 않는다)', async () => {
    const sut = makeSut(jest.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied' })));
    expect(await sut.getOriginalName(url)).toBe('해지 신청서.pdf');
    expect((sut as any).logger.warn).toHaveBeenCalledTimes(1);
  });

  it('경고에 원본 파일명을 남기지 않는다 (접근로그에선 가려놓고 여기서 새면 안 된다)', async () => {
    const sut = makeSut(jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { name: 'NoSuchBucket' })));
    await sut.getOriginalName(url);
    const logged = (sut as any).logger.warn.mock.calls[0][0] as string;
    expect(logged).not.toContain('해지');
    expect(logged).toContain('private/5/');
  });
});

/**
 * ★ '객체 없음' 판정을 isNotFoundError 로 통일한 회귀.
 * 예전엔 여기서 `e.name ?? e.Code` 로 따로 판정해, Code 에만 코드가 실린 에러가 name='Error' 에 가려
 * 정상 폴백인데도 경고가 나갔다(같은 질문에 답이 둘이면 언젠가 갈린다).
 */
describe('FileService.getOriginalName — 판정 통일 + 로그 안전', () => {
  const url = 'https://b.s3.amazonaws.com/private/5/0123456789abcdef-해지 신청서.pdf';
  const makeSut = (headImpl: jest.Mock) => {
    const sut = new FileService({ headOriginalName: headImpl } as any);
    (sut as any).logger = { warn: jest.fn() };
    return sut;
  };

  it('★Code 에만 NoSuchKey 가 실린 에러도 정상 폴백으로 본다 (경고 없음)', async () => {
    const sut = makeSut(jest.fn().mockRejectedValue(Object.assign(new Error('x'), { Code: 'NoSuchKey' })));
    expect(await sut.getOriginalName(url)).toBe('해지 신청서.pdf');
    expect((sut as any).logger.warn).not.toHaveBeenCalled();
  });

  it('★경고에 개행을 넣을 수 없다 (key·메시지 둘 다 정제)', async () => {
    const sut = makeSut(
      jest.fn().mockRejectedValue(Object.assign(new Error('a\nERROR 가짜'), { name: 'AccessDenied' })),
    );
    await sut.getOriginalName('https://b.s3.amazonaws.com/private/5%0aFAKE/0123456789abcdef-a.pdf');
    const logged = (sut as any).logger.warn.mock.calls[0][0] as string;
    expect(logged).not.toContain('\n');
  });
});
