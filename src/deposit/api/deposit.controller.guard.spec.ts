import { ForbiddenException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DepositController } from './deposit.controller';
import { DepositService } from '../application/deposit.service';
import { AuthService } from '../../auth/application/auth.service';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { IUserAuthority } from '../../user/interface/user.authority';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

/**
 * 입금내역 인가 가드 회귀 테스트.
 *
 * 이 화면은 은행 계좌번호·예금주 실명·금액을 노출하므로 두 겹으로 막는다.
 *  ① 역할가드 AuthUserSuperAndOperationAdminGuard 로 고객사(CORPORATE_ADMIN)를 하드 차단
 *  ② authorityValidator(DEPOSIT_HISTORY) 로 사내 계정 중 담당자만 통과
 * ② 를 빼먹으면 화면 메뉴는 숨겨져도 API 는 모든 운영자가 직접 호출할 수 있는
 * 인가 비대칭이 생긴다(금칙어 관리에서 실제로 있었던 결함).
 *
 * 가드의 유일한 의존성은 ILoginTokenValidator 라 DB/AppModule 없이 격리 부팅한다.
 */
describe('DepositController 인가 가드 (HTTP)', () => {
  let app: INestApplication;

  const depositService = {
    getList: jest.fn().mockResolvedValue({ list: [], totalCount: 0, totalPage: 0, currentPage: 1 }),
    getAccountList: jest.fn().mockResolvedValue({ accounts: [] }),
  };

  const authService = {
    authorityValidator: jest.fn().mockResolvedValue(undefined),
  };

  // token === authority 문자열로 사용. validateByToken 이 해당 권한 유저를 돌려준다.
  const tokenValidator = {
    validateByToken: jest.fn((token: string) => ({ id: 1, email: 't@test.com', authority: token })),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [DepositController],
      providers: [
        { provide: DepositService, useValue: depositService },
        { provide: AuthService, useValue: authService },
        AuthUserSuperAndOperationAdminGuard,
        { provide: 'ILoginTokenValidator', useValue: tokenValidator },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(() => {
    jest.clearAllMocks();
    authService.authorityValidator.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (role: IUserAuthority) => `Bearer ${role}`;

  const guardedEndpoints: string[] = ['/deposit/list', '/deposit/accounts'];

  it.each(guardedEndpoints)('토큰이 없으면 401 (%s)', async (path) => {
    await request(app.getHttpServer()).get(path).expect(401);

    expect(authService.authorityValidator).not.toHaveBeenCalled();
  });

  it.each(guardedEndpoints)('CORPORATE_ADMIN 은 역할가드에서 403 (%s)', async (path) => {
    await request(app.getHttpServer()).get(path).set('Authorization', auth(IUserAuthority.CORPORATE_ADMIN)).expect(403);

    expect(authService.authorityValidator).not.toHaveBeenCalled();
  });

  it.each(guardedEndpoints)('DEPOSIT_HISTORY 권한이 없는 운영자는 403 (%s)', async (path) => {
    authService.authorityValidator.mockRejectedValueOnce(new ForbiddenException('권한이 없습니다.'));

    await request(app.getHttpServer()).get(path).set('Authorization', auth(IUserAuthority.OPERATION_ADMIN)).expect(403);

    expect(authService.authorityValidator).toHaveBeenCalledWith(expect.anything(), UserAuthSubEnum.DEPOSIT_HISTORY);
  });

  it('권한이 있으면 목록 핸들러가 실행된다', async () => {
    await request(app.getHttpServer())
      .get('/deposit/list')
      .set('Authorization', auth(IUserAuthority.OPERATION_ADMIN))
      .expect(200);

    expect(authService.authorityValidator).toHaveBeenCalledWith(expect.anything(), UserAuthSubEnum.DEPOSIT_HISTORY);
    expect(depositService.getList).toHaveBeenCalledTimes(1);
  });

  it('권한이 있으면 계좌목록 핸들러가 실행된다', async () => {
    await request(app.getHttpServer())
      .get('/deposit/accounts')
      .set('Authorization', auth(IUserAuthority.SUPER_ADMIN))
      .expect(200);

    expect(depositService.getAccountList).toHaveBeenCalledTimes(1);
  });
});
