import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { UserSyncProductController } from './user.sync.product.controller';
import { UserSyncProductService } from '../application/user.sync.product.service';
import { AuthService } from '../../auth/application/auth.service';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { IUserAuthority } from '../../user/interface/user.authority';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

/**
 * 연동 상품(고객상품 관리) 인가 가드 회귀 테스트 (audit #43, M).
 *
 * 기존엔 getList 1곳만 authorityValidator(LINK_ITEM) 를 갖고, 나머지 9개 핸들러는
 * 클래스 가드(토큰만)뿐이라 LINK_ITEM 권한 없는 로그인 계정이 토큰 직접 호출로
 * 연동 구성·담당자 데이터를 임의 조회/변조할 수 있었다(방어심층 결여).
 *
 * 본 스펙은 가드를 실제로 태운 뒤 supertest 로 HTTP 응답을 확인한다.
 * 가드의 유일한 의존성은 ILoginTokenValidator 라 DB/AppModule 없이 격리 부팅한다.
 *
 * 방어심층(#38 partner_company 패턴 동일): 10개 엔드포인트 전부
 *  ① 역할가드 AuthUserSuperAndOperationAdminGuard 로 CORPORATE_ADMIN 을 하드 차단하고,
 *  ② authorityValidator(PRODUCT_CUSTOMER_LINK_ITEM) 로 서브권한을 검증한다.
 * 본 스펙은 ①(CORPORATE → 403)과 ②(authorityValidator 가 LINK_ITEM 으로 호출됨)를 검증한다.
 */
describe('UserSyncProductController 인가 가드 (HTTP)', () => {
  let app: INestApplication;

  const userSyncProductService = {
    getList: jest.fn().mockResolvedValue({}),
    updateStatus: jest.fn().mockResolvedValue({}),
    getCustomersByProduct: jest.fn().mockResolvedValue({}),
    getDetail: jest.fn().mockResolvedValue({}),
    registerEvent: jest.fn().mockResolvedValue({}),
    insertProduct: jest.fn().mockResolvedValue({}),
    deleteProduct: jest.fn().mockResolvedValue({}),
    getHeadPersonList: jest.fn().mockResolvedValue({}),
    getPersonsByBusinessNumber: jest.fn().mockResolvedValue({}),
    setHeadPerson: jest.fn().mockResolvedValue({}),
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
      controllers: [UserSyncProductController],
      providers: [
        { provide: UserSyncProductService, useValue: userSyncProductService },
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

  // [메서드, 경로] — 10개 엔드포인트 전부 자사관리자 역할가드 대상
  const guardedEndpoints: ['get' | 'post' | 'put' | 'patch' | 'delete', string][] = [
    ['get', '/user-sync-product/list'], // getList
    ['patch', '/user-sync-product/status'], // updateStatus
    ['get', '/user-sync-product/product/1/customers'], // getCustomersByProduct
    ['get', '/user-sync-product/detail/1'], // getDetail
    ['post', '/user-sync-product/event'], // registerEvent
    ['post', '/user-sync-product/event/product'], // insertProduct
    ['delete', '/user-sync-product/product'], // deleteProduct
    ['get', '/user-sync-product/head-person/list'], // getHeadPersonList
    ['get', '/user-sync-product/person/list'], // getPersonsByBusinessNumber
    ['patch', '/user-sync-product/person/head'], // setHeadPerson
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

  describe('자사관리자는 역할가드를 통과하고 authorityValidator(LINK_ITEM) 를 호출한다', () => {
    it('OPERATION_ADMIN: GET /user-sync-product/list → 통과 + authorityValidator(LINK_ITEM)', async () => {
      await request(app.getHttpServer())
        .get('/user-sync-product/list')
        .set('Authorization', auth(IUserAuthority.OPERATION_ADMIN))
        .expect(200);

      expect(authService.authorityValidator).toHaveBeenCalledWith(
        expect.objectContaining({ authority: IUserAuthority.OPERATION_ADMIN }),
        UserAuthSubEnum.PRODUCT_CUSTOMER_LINK_ITEM,
      );
    });

    it('SUPER_ADMIN: GET /user-sync-product/detail/1 → 통과 + authorityValidator(LINK_ITEM)', async () => {
      await request(app.getHttpServer())
        .get('/user-sync-product/detail/1')
        .set('Authorization', auth(IUserAuthority.SUPER_ADMIN))
        .expect(200);

      expect(authService.authorityValidator).toHaveBeenCalledWith(
        expect.anything(),
        UserAuthSubEnum.PRODUCT_CUSTOMER_LINK_ITEM,
      );
    });

    it('SUPER_ADMIN: PATCH /user-sync-product/person/head → 통과 + authorityValidator(LINK_ITEM)', async () => {
      await request(app.getHttpServer())
        .patch('/user-sync-product/person/head')
        .set('Authorization', auth(IUserAuthority.SUPER_ADMIN))
        .send({})
        .expect(200);

      expect(authService.authorityValidator).toHaveBeenCalledWith(
        expect.anything(),
        UserAuthSubEnum.PRODUCT_CUSTOMER_LINK_ITEM,
      );
    });
  });

  it('토큰이 없으면 401 (클래스 인증 가드)', async () => {
    await request(app.getHttpServer()).get('/user-sync-product/list').expect(401);
  });
});
