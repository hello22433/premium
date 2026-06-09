import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ProductController } from './product.controller';
import { ProductService } from '../application/product.service';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { AuthService } from '../../auth/application/auth.service';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAdminGuard } from '../../auth/api/auth.user.super-admin.guard';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { IUserAuthority } from '../../user/interface/user.authority';

/**
 * 상품관리 엔드포인트 인가 가드 회귀 테스트 (audit #31/#33/#34).
 *
 * 기존 컨트롤러 spec 은 .overrideGuard 로 가드를 무력화한 뒤 핸들러 본문만 검증한다.
 * 본 스펙은 가드를 override 하지 않고 실제로 태운 뒤 supertest 로 HTTP 응답을 확인한다.
 * 가드의 유일한 의존성은 ILoginTokenValidator 이므로 DB/AppModule 없이 격리 부팅 가능하다.
 *
 * 핵심 회귀: 클래스 가드 AuthUserAuthorizationGuard 는 인증만 수행하므로,
 * CORPORATE_ADMIN(고객사) 토큰으로 상품 생성/수정/삭제/대분류등록/엑셀다운로드/템플릿다운로드에
 * 접근하면 403 으로 차단되어야 한다.
 */
describe('ProductController 인가 가드 (HTTP)', () => {
  let app: INestApplication;

  const productService = {
    create: jest.fn().mockResolvedValue({}),
    updatePartial: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue(undefined),
    createClassification: jest.fn().mockResolvedValue({}),
    excelDownload: jest.fn(),
    excelTemplateDownload: jest.fn(),
  };

  // token === authority 문자열로 사용. validateByToken 이 해당 권한 유저를 돌려준다.
  const tokenValidator = {
    validateByToken: jest.fn((token: string) => ({ id: 1, email: 't@test.com', authority: token })),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ProductController],
      providers: [
        { provide: ProductService, useValue: productService },
        { provide: ActivityLogService, useValue: { createLog: jest.fn() } },
        { provide: AuthService, useValue: { authorityValidator: jest.fn() } },
        AuthUserAuthorizationGuard,
        AuthUserSuperAndOperationAdminGuard,
        AuthUserSuperAdminGuard,
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
  const guardedEndpoints: ['post' | 'patch' | 'delete' | 'get', string][] = [
    ['post', '/product'], // create (#31)
    ['patch', '/product'], // updatePartial (#31)
    ['delete', '/product/list'], // delete (#31)
    ['post', '/classification'], // createClassification (#31)
    ['post', '/product/excel-download'], // excelDownload (#33)
    ['get', '/product/excel-template-download'], // excelTemplateDownload (#34)
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
    it('OPERATION_ADMIN: POST /product → 가드 통과 후 핸들러 실행', async () => {
      await request(app.getHttpServer())
        .post('/product')
        .set('Authorization', auth(IUserAuthority.OPERATION_ADMIN))
        .send({})
        .expect(201);

      expect(productService.create).toHaveBeenCalled();
    });

    it('SUPER_ADMIN: POST /product → 가드 통과 후 핸들러 실행', async () => {
      await request(app.getHttpServer())
        .post('/product')
        .set('Authorization', auth(IUserAuthority.SUPER_ADMIN))
        .send({})
        .expect(201);
    });
  });

  it('토큰이 없으면 401 (클래스 인증 가드)', async () => {
    await request(app.getHttpServer()).post('/product').send({}).expect(401);
  });
});
