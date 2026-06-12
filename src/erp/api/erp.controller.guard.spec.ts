import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ErpController } from './erp.controller';
import { ErpProductService } from '../application/erp.product.service';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { IUserAuthority } from '../../user/interface/user.authority';

/**
 * ERP 품목조회 인가 가드 회귀 테스트 (audit #40).
 *
 * 기존 클래스 가드 AuthUserAuthorizationGuard 는 인증만 수행하므로,
 * CORPORATE_ADMIN(고객사) 토큰으로 품목 마스터(IN_PRICE/원가/단가 등)에 접근 가능했다.
 * 본 스펙은 가드를 실제로 태운 뒤 supertest 로 HTTP 응답을 확인한다.
 * 가드의 유일한 의존성은 ILoginTokenValidator 라 DB/AppModule 없이 격리 부팅한다.
 *
 * 핵심 회귀: CORPORATE_ADMIN 은 ERP 품목조회 2개 엔드포인트 모두 403 으로 차단되어야 한다.
 */
describe('ErpController 인가 가드 (HTTP)', () => {
  let app: INestApplication;

  const erpProductService = {
    getProductsList: jest.fn().mockResolvedValue({ Status: 200, Error: null, Data: null }),
    getProduct: jest.fn().mockResolvedValue({ Status: 200, Error: null, Data: null }),
  };

  // token === authority 문자열로 사용. validateByToken 이 해당 권한 유저를 돌려준다.
  const tokenValidator = {
    validateByToken: jest.fn((token: string) => ({ id: 1, email: 't@test.com', authority: token })),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ErpController],
      providers: [
        { provide: ErpProductService, useValue: erpProductService },
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

  // [경로] — 자사관리자 가드가 붙은 핸들러
  const guardedEndpoints: [string][] = [
    ['/erp/products'], // 목록 (#40)
    ['/erp/products/P001'], // 단건 (#40)
  ];

  describe('CORPORATE_ADMIN 은 403 으로 차단된다', () => {
    it.each(guardedEndpoints)('GET %s → 403', async (path) => {
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', auth(IUserAuthority.CORPORATE_ADMIN))
        .expect(403);
    });
  });

  describe('자사관리자는 가드를 통과한다 (403 이 아니다)', () => {
    it('OPERATION_ADMIN: GET /erp/products → 가드 통과 후 핸들러 실행', async () => {
      await request(app.getHttpServer())
        .get('/erp/products')
        .set('Authorization', auth(IUserAuthority.OPERATION_ADMIN))
        .expect(200);

      expect(erpProductService.getProductsList).toHaveBeenCalled();
    });

    it('SUPER_ADMIN: GET /erp/products/:prodCd → 가드 통과 후 핸들러 실행', async () => {
      await request(app.getHttpServer())
        .get('/erp/products/P001')
        .set('Authorization', auth(IUserAuthority.SUPER_ADMIN))
        .expect(200);

      expect(erpProductService.getProduct).toHaveBeenCalled();
    });
  });

  it('토큰이 없으면 401', async () => {
    await request(app.getHttpServer()).get('/erp/products').expect(401);
  });
});
