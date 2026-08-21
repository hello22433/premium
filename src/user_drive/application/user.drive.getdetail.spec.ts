import { UserDriveService } from './user.drive.service';
import { In } from 'typeorm';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserDriveStatus } from '../interface/user.drive.status';

/**
 * getDetail 의 files 조립 회귀:
 *  - url/name 짝맞춤 + 순서 보존
 *  - MAX_FILE_META_LOOKUP(=10) 경계: index<10 은 getOriginalName(HeadObject), index>=10 은 extractOriginalFileName(key 복원)
 *  - fail-soft: 한 항목의 이름 조회가 던져도 상세 전체가 500 나지 않고 마지막 경로조각으로 degrade
 */
describe('UserDriveService.getDetail — files 조립', () => {
  const admin = { id: 99, authority: IUserAuthority.OPERATION_ADMIN } as any; // 관리자 → receiveAt save 경로 회피

  const makeSut = (
    fileUrls: string[],
    fileServiceOverrides: Record<string, any> = {},
    // 발신자(5) 소유가 아닌 첨부의 업로더 중 SUPER 인 id 목록. resolveHeadableUrls 의 1회 조회를 흉내낸다.
    superAdminIds: number[] = [],
  ) => {
    const drive = {
      id: 1,
      senderId: 5,
      receiverId: 10,
      status: IUserDriveStatus.REGISTER,
      sendAt: new Date('2026-01-01T00:00:00Z'),
      title: 't',
      content: 'c',
      replyContent: null,
      filePath: fileUrls.length ? fileUrls.join(',') : null,
      sender: { company: { businessName: 'BizCo' } },
      receiver: { personName: '홍길동', email: 'a@b.com', personPhoneNumber: '010-0000-0000' },
    };
    const driveRepo: any = { findOne: jest.fn().mockResolvedValue(drive), save: jest.fn() };
    const userRepo: any = { find: jest.fn().mockResolvedValue(superAdminIds.map((id) => ({ id }))) };
    const fileService: any = {
      isOwnStorageUrl: jest.fn().mockReturnValue(true),
      // 실제 구현과 동일하게 decodeURIComponent 까지 (깨진 percent-encoding 케이스를 태우기 위해).
      extractStorageKey: (u: string) => decodeURIComponent(new URL(u).pathname.replace(/^\/+/, '')),
      getOriginalName: jest.fn(async (u: string) => `meta:${u.split('/').pop()}`),
      // 실제 구현은 내부에서 extractStorageKey 를 거치므로 비URL 입력이면 던진다 — 목도 같게 둔다.
      // (목이 안 던지면 fail-soft 폴백 경로가 테스트에서 아예 안 돌아 회귀를 못 잡는다.)
      extractOriginalFileName: jest.fn((u: string) => {
        const key = decodeURIComponent(new URL(u).pathname.replace(/^\/+/, ''));
        return `key:${key.split('/').pop()}`;
      }),
      ...fileServiceOverrides,
    };
    const sut = new UserDriveService(driveRepo, userRepo, fileService);
    (sut as any).logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    return { sut, fileService, userRepo, logger: (sut as any).logger };
  };

  it('url/name 짝을 순서대로 조립한다 (메타데이터 우선)', async () => {
    const urls = ['https://b/private/5/u1-a.xlsx', 'https://b/private/5/u2-b.xlsx'];
    const { sut, fileService } = makeSut(urls);

    const res = await sut.getDetail(admin, { id: 1 });

    expect(res.files).toEqual([
      { url: urls[0], name: 'meta:u1-a.xlsx' },
      { url: urls[1], name: 'meta:u2-b.xlsx' },
    ]);
    expect(res.filePathList).toEqual(urls); // 하위호환 필드 유지
    expect(fileService.getOriginalName).toHaveBeenCalledTimes(2);
    expect(fileService.extractOriginalFileName).not.toHaveBeenCalled();
  });

  it('첨부 11개: 앞 10개는 getOriginalName, 11번째는 extractOriginalFileName (경계)', async () => {
    const urls = Array.from({ length: 11 }, (_, i) => `https://b/private/5/u${i}-f${i}.xlsx`);
    const { sut, fileService } = makeSut(urls);

    const res = await sut.getDetail(admin, { id: 1 });

    expect(fileService.getOriginalName).toHaveBeenCalledTimes(10);
    expect(fileService.extractOriginalFileName).toHaveBeenCalledTimes(1);
    expect(res.files[9].name).toBe('meta:u9-f9.xlsx'); // index 9 → HeadObject
    expect(res.files[10].name).toBe('key:u10-f10.xlsx'); // index 10 → key 복원
  });

  it('fail-soft: 한 항목의 이름 조회가 throw 해도 상세 전체가 죽지 않고 폴백', async () => {
    // 비URL(스킴 없음) 단독 항목은 parseFilePathList 에서 앞 URL 에 안 붙고 그대로 남는다(맨 앞이라 직전 URL 없음).
    // 실제 코드에선 이런 항목이 getOriginalName 내부 new URL 에서 throw → getDetail 이 폴백해야 한다.
    const bad = 'brokenfrag';
    const good = 'https://b/private/5/u1-good.xlsx';
    const { sut, logger } = makeSut([bad, good], {
      getOriginalName: jest.fn(async (u: string) => {
        if (u === bad) throw new Error('ERR_INVALID_URL');
        return `meta:${u.split('/').pop()}`;
      }),
    });

    const res = await sut.getDetail(admin, { id: 1 });

    expect(res.files[0]).toEqual({ url: bad, name: 'brokenfrag' }); // 마지막 경로조각으로 degrade
    expect(res.files[1]).toEqual({ url: good, name: 'meta:u1-good.xlsx' });
    // ★ 결과만 보면 warn 을 지워도 초록이다 — 조용히 열화되는 것을 막는 건 이 단언뿐이다.
    //   (바로 아래 resolveHeadableUrls 스펙은 이미 이 단언을 하는데 여기만 빠져 있었다 — 비대칭)
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('첨부 없음 → files 빈 배열', async () => {
    const { sut, fileService } = makeSut([]);
    const res = await sut.getDetail(admin, { id: 1 });
    expect(res.files).toEqual([]);
    expect(fileService.getOriginalName).not.toHaveBeenCalled();
  });

  it('레거시(image/·file/) 는 HeadObject 스킵하고 key 복원, private 만 HeadObject (M-3)', async () => {
    const urls = ['https://b/image/abc-legacy.png', 'https://b/file/123-old.xlsx', 'https://b/private/5/u-new.xlsx'];
    const { sut, fileService } = makeSut(urls);

    const res = await sut.getDetail(admin, { id: 1 });

    expect(fileService.getOriginalName).toHaveBeenCalledTimes(1); // private 1개만
    expect(fileService.getOriginalName).toHaveBeenCalledWith('https://b/private/5/u-new.xlsx');
    expect(fileService.extractOriginalFileName).toHaveBeenCalledTimes(2); // 레거시 2개
    expect(res.files.map((f) => f.name)).toEqual(['key:abc-legacy.png', 'key:123-old.xlsx', 'meta:u-new.xlsx']);
  });

  it('fail-soft 폴백명은 uuid 접두사(첫 - 앞)를 벗긴다 (표시 일관성, LOW-3)', async () => {
    const bad = 'uuid1234-보고서.xlsx'; // 스킴 없음 → extractStorageKey 의 new URL 에서 throw → 폴백
    const { sut } = makeSut([bad]);
    const res = await sut.getDetail(admin, { id: 1 });
    expect(res.files[0]).toEqual({ url: bad, name: '보고서.xlsx' });
  });
  /**
   * ★ HeadObject 는 '그 key 의 진짜 원본 파일명' 을 응답에 실어준다 → 다운로드를 안 해도 이름이 샌다.
   *   그래서 대상 판정을 다운로드 허용 규칙(발신자 소유 or 업로더가 SUPER)과 같게 맞춘다.
   *   빠진 첨부는 차단이 아니라 key 복원 이름으로 표시된다.
   */
  describe('HeadObject 대상 좁히기 (다운로드 허용 규칙과 동일 기준)', () => {
    const own = 'https://b/private/5/u1-a.xlsx'; // 발신자(5) 소유
    const foreign = 'https://b/private/77/u2-secret.xlsx'; // 타인 소유

    it('발신자 소유 private → HeadObject 로 진짜 원본명', async () => {
      const { sut, fileService } = makeSut([own]);
      const res: any = await sut.getDetail(admin, { id: 1 });
      expect(res.files).toEqual([{ url: own, name: 'meta:u1-a.xlsx' }]);
      expect(fileService.getOriginalName).toHaveBeenCalledTimes(1);
    });

    it('★타인 소유 private(비SUPER) → HeadObject 안 하고 key 복원명', async () => {
      const { sut, fileService } = makeSut([foreign]);
      const res: any = await sut.getDetail(admin, { id: 1 });
      expect(res.files).toEqual([{ url: foreign, name: 'key:u2-secret.xlsx' }]);
      expect(fileService.getOriginalName).not.toHaveBeenCalled();
    });

    // ※ 예전엔 '허용' 이었다 — 업로더가 지금 SUPER 인지 조회해서 통과시켰다. 그 판정은 첨부 당시의
    //   사실이 아니라 지금 바뀌는 값이라(승격·강등) 같은 첨부가 보였다 안 보였다 했다.
    //   쓰기 쪽이 ownerId === senderId 를 강제하게 되면서 이 예외 자체가 없어졌다.
    it('★타인 소유는 업로더가 SUPER 여도 HeadObject 안 한다 (현재 권한을 안 본다)', async () => {
      const { sut, fileService, userRepo } = makeSut([foreign], {}, [77]);
      const res: any = await sut.getDetail(admin, { id: 1 });
      expect(res.files).toEqual([{ url: foreign, name: 'key:u2-secret.xlsx' }]);
      expect(fileService.getOriginalName).not.toHaveBeenCalled();
      expect(userRepo.find).not.toHaveBeenCalled();
    });

    it('★우리 버킷 URL 이 아니면 → HeadObject 안 함 (임의 host 로 객체 존재 탐지 차단)', async () => {
      const { sut, fileService } = makeSut([own], { isOwnStorageUrl: jest.fn().mockReturnValue(false) });
      const res: any = await sut.getDetail(admin, { id: 1 });
      expect(res.files).toEqual([{ url: own, name: 'key:u1-a.xlsx' }]);
      expect(fileService.getOriginalName).not.toHaveBeenCalled();
    });

    it('깨진 percent-encoding key → HeadObject 안 하고 폴백 (500 아님)', async () => {
      const broken = 'https://b/private/5/%';
      const { sut, fileService } = makeSut([broken]);
      const res: any = await sut.getDetail(admin, { id: 1 });
      expect(res.files).toHaveLength(1);
      expect(fileService.getOriginalName).not.toHaveBeenCalled();
    });

    // ★ 목은 where 를 무시하고 넘긴 배열을 그대로 돌려준다. 그래서 where 에서
    //   authority: SUPER_ADMIN 을 지워도 결과 단언만으로는 전부 초록이다(뮤테이션 생존 확인).
    // ★ 판정에서 DB 조회가 통째로 사라졌다. 조회가 남아 있으면 그게 곧 '가변 판정' 이라는 뜻이므로
    //   결과가 아니라 **호출 여부**를 고정한다.
    it('★업로더 권한 조회를 아예 하지 않는다 (판정이 불변식 한 줄이다)', async () => {
      const { sut, userRepo } = makeSut([foreign, 'https://b/private/88/u3-c.xlsx']);
      await sut.getDetail(admin, { id: 1 });
      expect(userRepo.find).not.toHaveBeenCalled();
    });

    // ★ 다운로드 쪽에는 같은 가드의 테스트가 있는데(download.spec 의 private// 케이스) 조회 쪽만 없었다.
    //   지우면 Number('')=0 / Number('abc')=NaN 이 그대로 In([NaN]) 로 쿼리에 실린다.
    it('ownerId 세그먼트가 숫자가 아니면 대상에서 빼고 조회도 안 한다', async () => {
      const weird = 'https://b/private/abc/u1-a.xlsx';
      const { sut, fileService, userRepo } = makeSut([weird]);
      const res: any = await sut.getDetail(admin, { id: 1 });
      expect(res.files).toEqual([{ url: weird, name: 'key:u1-a.xlsx' }]);
      expect(fileService.getOriginalName).not.toHaveBeenCalled();
      expect(userRepo.find).not.toHaveBeenCalled();
    });

    // ★ 이 조회는 '이름을 예쁘게 보여줄지' 를 정하는 곁가지다. 던지게 두면 제목·본문·답변까지 못 보는
    it('발신자 소유만 있으면 업로더 권한 조회를 아예 하지 않는다', async () => {
      const { sut, userRepo } = makeSut([own]);
      await sut.getDetail(admin, { id: 1 });
      expect(userRepo.find).not.toHaveBeenCalled();
    });
  });
});
