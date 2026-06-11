import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PartnerCompanyController } from './partner.company.controller';
import { PartnerCompanyService } from '../application/partner.company.service';
import { AuthService } from '../../auth/application/auth.service';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { IUserAuthority } from '../../user/interface/user.authority';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

/**
 * 협력사 관리 인가 가드 회귀 테스트 (audit #38, H).
 *
 * 기존 컨트롤러 spec 은 .overrideGuard 로 가드를 무력화하므로 역할 차단을 못 잡는다.
 * 본 스펙은 가드를 실제로 태운 뒤 supertest 로 HTTP 응답을 확인한다.
 * 가드의 유일한 의존성은 ILoginTokenValidator 라 DB/AppModule 없이 격리 부팅한다.
 *
 * 방어심층: 관리 엔드포인트(select/list/detail/create/update)는
 *  ① 역할가드 AuthUserSuperAndOperationAdminGuard 로 CORPORATE_ADMIN 을 하드 차단하고,
 *  ② 관리 4종(list/detail/create/update)은 추가로 authorityValidator(PARTNER) 를 호출한다.
 * 본 스펙은 ①(CORPORATE → 403)과 ②(authorityValidator 가 PARTNER 로 호출됨)를 검증한다.
 */
describe('PartnerCompanyController 인가 가드 (HTTP)', () => {
  let app: INestApplication;

  const partnerCompanyService = {
    getSelectList: jest.fn().mockResolvedValue([]),
    getList: jest.fn().mockResolvedValue({}),
    getDetail: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
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
      controllers: [PartnerCompanyController],
      providers: [
        { provide: PartnerCompanyService, useValue: partnerCompanyService },
        { provide: AuthService, useValue: authService },
        AuthUserAuthorizationGuard,
        AuthUserSuperAndOperationAdminGuard,
        { provide: 'ILoginTokenValidator', useValue: tokenValidator },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (role: IUserAuthority) => `Bearer ${role}`;

  // [메서드, 경로] — 자사관리자 역할가드가 붙은 핸들러
  const guardedEndpoints: ['get' | 'post' | 'put', string][] = [
    ['get', '/partner-company/select/list'], // getSelectList (#38)
    ['get', '/partner-company/list'], // getList (#38)
    ['get', '/partner-company/detail/1'], // getDetail (#38)
    ['post', '/partner-company'], // create (#38)
    ['put', '/partner-company'], // update (#38)
  ];

  describe('CORPORATE_ADMIN 은 403 으로 차단된다 (역할가드)', () => {
    it.each(guardedEndpoints)('%s %s → 403', async (method, path) => {
      await request(app.getHttpServer())
        [method](path)
        .set('Authorization', auth(IUserAuthority.CORPORATE_ADMIN))
        .send({})
        .expect(403);
    });
  });

  describe('자사관리자는 역할가드를 통과하고 authorityValidator(PARTNER) 를 호출한다', () => {
    it('OPERATION_ADMIN: GET /partner-company/list → 통과 + authorityValidator(PARTNER)', async () => {
      await request(app.getHttpServer())
        .get('/partner-company/list')
        .set('Authorization', auth(IUserAuthority.OPERATION_ADMIN))
        .expect(200);

      expect(authService.authorityValidator).toHaveBeenCalledWith(
        expect.objectContaining({ authority: IUserAuthority.OPERATION_ADMIN }),
        UserAuthSubEnum.PARTNER,
      );
    });

    it('SUPER_ADMIN: GET /partner-company/detail/1 → 통과 + authorityValidator(PARTNER)', async () => {
      await request(app.getHttpServer())
        .get('/partner-company/detail/1')
        .set('Authorization', auth(IUserAuthority.SUPER_ADMIN))
        .expect(200);

      expect(authService.authorityValidator).toHaveBeenCalledWith(expect.anything(), UserAuthSubEnum.PARTNER);
    });

    it('SUPER_ADMIN: POST /partner-company → 통과 + authorityValidator(PARTNER)', async () => {
      await request(app.getHttpServer())
        .post('/partner-company')
        .set('Authorization', auth(IUserAuthority.SUPER_ADMIN))
        .send({})
        .expect(201);

      expect(authService.authorityValidator).toHaveBeenCalledWith(expect.anything(), UserAuthSubEnum.PARTNER);
    });
  });

  it('select/list 는 authorityValidator 없이 역할가드만으로 통과한다', async () => {
    await request(app.getHttpServer())
      .get('/partner-company/select/list')
      .set('Authorization', auth(IUserAuthority.OPERATION_ADMIN))
      .expect(200);

    expect(authService.authorityValidator).not.toHaveBeenCalled();
  });

  it('토큰이 없으면 401 (클래스 인증 가드)', async () => {
    await request(app.getHttpServer()).get('/partner-company/list').expect(401);
  });
});
