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
    const { sut } = makeSut([bad, good], {
      getOriginalName: jest.fn(async (u: string) => {
        if (u === bad) throw new Error('ERR_INVALID_URL');
        return `meta:${u.split('/').pop()}`;
      }),
    });

    const res = await sut.getDetail(admin, { id: 1 });

    expect(res.files[0]).toEqual({ url: bad, name: 'brokenfrag' }); // 마지막 경로조각으로 degrade
    expect(res.files[1]).toEqual({ url: good, name: 'meta:u1-good.xlsx' });
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

    it('타인 소유라도 업로더가 SUPER 면 → HeadObject (SUPER 교차수정 첨부 과차단 안 함)', async () => {
      const { sut, fileService } = makeSut([foreign], {}, [77]);
      const res: any = await sut.getDetail(admin, { id: 1 });
      expect(res.files).toEqual([{ url: foreign, name: 'meta:u2-secret.xlsx' }]);
      expect(fileService.getOriginalName).toHaveBeenCalledTimes(1);
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
    //   "타인 소유에 HeadObject 를 걸지 말지" 를 가르는 유일한 조건이므로 인자 자체를 고정한다.
    it('업로더 권한 조회는 SUPER_ADMIN 조건으로만 한다 (조회 인자 고정)', async () => {
      const { sut, userRepo } = makeSut(['https://b/private/77/u2-secret.xlsx']);
      await sut.getDetail(admin, { id: 1 });
      expect(userRepo.find).toHaveBeenCalledWith({
        where: { id: In([77]), authority: IUserAuthority.SUPER_ADMIN },
        select: ['id'],
      });
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

    it('타인 소유가 여러 건이어도 업로더 권한 조회는 1회로 묶는다', async () => {
      const f2 = 'https://b/private/88/u3-c.xlsx';
      const { sut, userRepo } = makeSut([foreign, f2, foreign]);
      await sut.getDetail(admin, { id: 1 });
      expect(userRepo.find).toHaveBeenCalledTimes(1);
    });

    // ★ 이 조회는 '이름을 예쁘게 보여줄지' 를 정하는 곁가지다. 던지게 두면 제목·본문·답변까지 못 보는
    //   500 이 된다(나머지 이름 조회는 전부 fail-soft). 보안축은 fail-closed(대상에서 제외)로 유지한다.
    it('★업로더 권한 조회가 실패해도 상세는 열린다 — 해당 첨부만 key 복원명 + 경고', async () => {
      const foreign2 = 'https://b/private/77/u2-secret.xlsx';
      const { sut, fileService, userRepo, logger } = makeSut([foreign2]);
      userRepo.find.mockRejectedValue(new Error('pool timeout'));

      const res: any = await sut.getDetail(admin, { id: 1 });

      expect(res.title).toBe('t'); // 문서 자체는 정상 응답
      expect(res.files).toEqual([{ url: foreign2, name: 'key:u2-secret.xlsx' }]);
      expect(fileService.getOriginalName).not.toHaveBeenCalled(); // fail-closed
      expect(logger.warn).toHaveBeenCalledTimes(1); // 조용히 열화되지 않는다
    });

    it('발신자 소유만 있으면 업로더 권한 조회를 아예 하지 않는다', async () => {
      const { sut, userRepo } = makeSut([own]);
      await sut.getDetail(admin, { id: 1 });
      expect(userRepo.find).not.toHaveBeenCalled();
    });
  });
});
