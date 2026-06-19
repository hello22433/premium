import { ForbiddenException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ForbiddenWordController } from './forbidden.word.controller';
import { ForbiddenWordService } from '../application/forbidden.word.service';
import { AuthService } from '../../auth/application/auth.service';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { IUserAuthority } from '../../user/interface/user.authority';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

/**
 * 금칙어 관리 인가 가드 회귀 테스트.
 *
 * 방어심층: 모든 엔드포인트는
 *  ① 역할가드 AuthUserSuperAndOperationAdminGuard 로 CORPORATE_ADMIN 을 하드 차단하고,
 *  ② 추가로 authorityValidator(FORBIDDEN_WORD) 를 호출한다.
 * 기존에는 ② 가 누락돼, authorityList 에서 FORBIDDEN_WORD 를 뺀 운영자도
 * 화면은 막히지만 API 는 직접 호출 가능한 인가 비대칭이 있었다.
 * 본 스펙은 ①(CORPORATE → 403)과 ②(authorityValidator 가 FORBIDDEN_WORD 로 호출됨,
 * 검증 실패 시 403 전파)를 검증한다.
 *
 * 가드의 유일한 의존성은 ILoginTokenValidator 라 DB/AppModule 없이 격리 부팅한다.
 */
describe('ForbiddenWordController 인가 가드 (HTTP)', () => {
  let app: INestApplication;

  const forbiddenWordService = {
    getList: jest.fn().mockResolvedValue({}),
    getHistory: jest.fn().mockResolvedValue({}),
    getBlockLog: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
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
      controllers: [ForbiddenWordController],
      providers: [
        { provide: ForbiddenWordService, useValue: forbiddenWordService },
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

  // [메서드, 경로] — 모든 핸들러가 역할가드 + authorityValidator(FORBIDDEN_WORD) 로 보호된다.
  const guardedEndpoints: ['get' | 'post' | 'put' | 'delete', string][] = [
    ['get', '/forbidden-word'],
    ['get', '/forbidden-word/history'],
    ['get', '/forbidden-word/block-log'],
    ['post', '/forbidden-word'],
    ['put', '/forbidden-word/1'],
    ['delete', '/forbidden-word/1'],
  ];

  describe('CORPORATE_ADMIN 은 403 으로 차단된다 (역할가드)', () => {
    it.each(guardedEndpoints)('%s %s → 403', async (method, path) => {
      await request(app.getHttpServer())
        [method](path)
        .set('Authorization', auth(IUserAuthority.CORPORATE_ADMIN))
        .send({})
        .expect(403);

      expect(authService.authorityValidator).not.toHaveBeenCalled();
    });
  });

  describe('authorityValidator(FORBIDDEN_WORD) 가 실패하면 403 으로 차단된다', () => {
    it.each(guardedEndpoints)('%s %s → 403', async (method, path) => {
      authService.authorityValidator.mockRejectedValueOnce(new ForbiddenException('권한이 없습니다.'));

      await request(app.getHttpServer())
        [method](path)
        .set('Authorization', auth(IUserAuthority.OPERATION_ADMIN))
        .send({})
        .expect(403);

      expect(authService.authorityValidator).toHaveBeenCalledWith(
        expect.anything(),
        UserAuthSubEnum.FORBIDDEN_WORD,
      );
    });
  });

  describe('검증 통과 시 핸들러가 실행되며 authorityValidator(FORBIDDEN_WORD) 가 호출된다', () => {
    it('OPERATION_ADMIN: GET /forbidden-word → 통과 + authorityValidator(FORBIDDEN_WORD)', async () => {
      await request(app.getHttpServer())
        .get('/forbidden-word')
        .set('Authorization', auth(IUserAuthority.OPERATION_ADMIN))
        .expect(200);

      expect(forbiddenWordService.getList).toHaveBeenCalled();
      expect(authService.authorityValidator).toHaveBeenCalledWith(
        expect.objectContaining({ authority: IUserAuthority.OPERATION_ADMIN }),
        UserAuthSubEnum.FORBIDDEN_WORD,
      );
    });

    it('SUPER_ADMIN: POST /forbidden-word → 통과 + authorityValidator(FORBIDDEN_WORD)', async () => {
      await request(app.getHttpServer())
        .post('/forbidden-word')
        .set('Authorization', auth(IUserAuthority.SUPER_ADMIN))
        .send({ word: '비속어', reason: '신규 등록' })
        .expect(201);

      expect(forbiddenWordService.create).toHaveBeenCalled();
      expect(authService.authorityValidator).toHaveBeenCalledWith(
        expect.anything(),
        UserAuthSubEnum.FORBIDDEN_WORD,
      );
    });

    it('SUPER_ADMIN: DELETE /forbidden-word/1 → 통과 + authorityValidator(FORBIDDEN_WORD)', async () => {
      await request(app.getHttpServer())
        .delete('/forbidden-word/1')
        .set('Authorization', auth(IUserAuthority.SUPER_ADMIN))
        .send({ reason: '오등록 삭제' })
        .expect(200);

      expect(forbiddenWordService.delete).toHaveBeenCalled();
      expect(authService.authorityValidator).toHaveBeenCalledWith(
        expect.anything(),
        UserAuthSubEnum.FORBIDDEN_WORD,
      );
    });
  });

  it('토큰이 없으면 401 (클래스 인증 가드)', async () => {
    await request(app.getHttpServer()).get('/forbidden-word').expect(401);
  });
});
