import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BrandController } from './brand.controller';
import { BrandService } from '../application/brand.service';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { IUserAuthority } from '../../user/interface/user.authority';

/**
 * 브랜드 등록/수정 인가 가드 회귀 테스트 (audit #37).
 *
 * 기존 컨트롤러 spec 은 .overrideGuard 로 가드를 무력화하므로 역할 차단을 못 잡는다.
 * 본 스펙은 가드를 실제로 태운 뒤 supertest 로 HTTP 응답을 확인한다.
 * 가드의 유일한 의존성은 ILoginTokenValidator 라 DB/AppModule 없이 격리 부팅한다.
 *
 * 핵심 회귀: 클래스 가드 AuthUserAuthorizationGuard 는 인증만 수행하므로,
 * CORPORATE_ADMIN(고객사) 토큰으로 브랜드 생성/수정에 접근하면 403 으로 차단되어야 한다.
 */
describe('BrandController 인가 가드 (HTTP)', () => {
  let app: INestApplication;

  const brandService = {
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
  };

  // token === authority 문자열로 사용. validateByToken 이 해당 권한 유저를 돌려준다.
  const tokenValidator = {
    validateByToken: jest.fn((token: string) => ({ id: 1, email: 't@test.com', authority: token })),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BrandController],
      providers: [
        { provide: BrandService, useValue: brandService },
        AuthUserAuthorizationGuard,
        AuthUserSuperAndOperationAdminGuard,
        { provide: 'ILoginTokenValidator', useValue: tokenValidator },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (role: IUserAuthority) => `Bearer ${role}`;

  // [메서드, 경로] — 자사관리자 가드가 붙은 핸들러
  const guardedEndpoints: ['post' | 'put', string][] = [
    ['post', '/brand'], // create (#37)
    ['put', '/brand'], // update (#37)
  ];

  describe('CORPORATE_ADMIN 은 403 으로 차단된다', () => {
    it.each(guardedEndpoints)('%s %s → 403', async (method, path) => {
      await request(app.getHttpServer())
        [method](path)
        .set('Authorization', auth(IUserAuthority.CORPORATE_ADMIN))
        .send({})
        .expect(403);
    });
  });

  describe('자사관리자는 가드를 통과한다 (403 이 아니다)', () => {
    it('OPERATION_ADMIN: POST /brand → 가드 통과 후 핸들러 실행', async () => {
      await request(app.getHttpServer())
        .post('/brand')
        .set('Authorization', auth(IUserAuthority.OPERATION_ADMIN))
        .send({})
        .expect(201);

      expect(brandService.create).toHaveBeenCalled();
    });

    it('SUPER_ADMIN: PUT /brand → 가드 통과 후 핸들러 실행', async () => {
      await request(app.getHttpServer())
        .put('/brand')
        .set('Authorization', auth(IUserAuthority.SUPER_ADMIN))
        .send({})
        .expect(200);
    });
  });

  it('토큰이 없으면 401 (클래스 인증 가드)', async () => {
    await request(app.getHttpServer()).post('/brand').send({}).expect(401);
  });
});
