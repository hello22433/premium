import { ForbiddenException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ProductChoiceController } from './product.choice.controller';
import { ProductChoiceService } from '../application/product.choice.service';
import { AuthService } from '../../auth/application/auth.service';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { IUserAuthority } from '../../user/interface/user.authority';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

/**
 * 초이스쿠폰 등록/수정 인가 회귀 테스트 (audit #36).
 *
 * create/updatePartial 은 형제 핸들러(getProductList/checkDelete/delete)와 달리
 * authorityValidator(PRODUCT_CHOICE) 호출이 누락돼 있었다(인가 비대칭).
 * 본 스펙은 두 핸들러가 실제로 authorityValidator(PRODUCT_CHOICE) 를 호출하는지,
 * 그리고 검증 실패(ForbiddenException) 가 403 으로 전파되는지 확인한다.
 *
 * 가드의 유일한 의존성은 ILoginTokenValidator 라 DB/AppModule 없이 격리 부팅한다.
 */
describe('ProductChoiceController 인가 (HTTP)', () => {
  let app: INestApplication;

  const productChoiceService = {
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
  };

  const authService = {
    authorityValidator: jest.fn().mockResolvedValue(undefined),
  };

  const tokenValidator = {
    validateByToken: jest.fn((token: string) => ({ id: 1, email: 't@test.com', authority: token })),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ProductChoiceController],
      providers: [
        { provide: ProductChoiceService, useValue: productChoiceService },
        { provide: AuthService, useValue: authService },
        AuthUserAuthorizationGuard,
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

  // [메서드, 경로] — authorityValidator(PRODUCT_CHOICE) 가 붙은 핸들러
  const guardedEndpoints: ['post' | 'put', string][] = [
    ['post', '/product-choice'], // create (#36)
    ['put', '/product-choice'], // updatePartial (#36)
  ];

  describe('authorityValidator(PRODUCT_CHOICE) 가 실패하면 403 으로 차단된다', () => {
    it.each(guardedEndpoints)('%s %s → 403', async (method, path) => {
      authService.authorityValidator.mockRejectedValueOnce(new ForbiddenException('권한이 없습니다.'));

      await request(app.getHttpServer())
        [method](path)
        .set('Authorization', auth(IUserAuthority.CORPORATE_ADMIN))
        .send({})
        .expect(403);

      expect(authService.authorityValidator).toHaveBeenCalledWith(expect.anything(), UserAuthSubEnum.PRODUCT_CHOICE);
    });
  });

  describe('검증 통과 시 핸들러가 실행되며 authorityValidator(PRODUCT_CHOICE) 가 호출된다', () => {
    it('POST /product-choice → create + authorityValidator(PRODUCT_CHOICE)', async () => {
      await request(app.getHttpServer())
        .post('/product-choice')
        .set('Authorization', auth(IUserAuthority.OPERATION_ADMIN))
        .send({})
        .expect(201);

      expect(productChoiceService.create).toHaveBeenCalled();
      expect(authService.authorityValidator).toHaveBeenCalledWith(expect.anything(), UserAuthSubEnum.PRODUCT_CHOICE);
    });

    it('PUT /product-choice → update + authorityValidator(PRODUCT_CHOICE)', async () => {
      await request(app.getHttpServer())
        .put('/product-choice')
        .set('Authorization', auth(IUserAuthority.SUPER_ADMIN))
        .send({})
        .expect(200);

      expect(productChoiceService.update).toHaveBeenCalled();
      expect(authService.authorityValidator).toHaveBeenCalledWith(expect.anything(), UserAuthSubEnum.PRODUCT_CHOICE);
    });
  });

  it('토큰이 없으면 401 (클래스 인증 가드)', async () => {
    await request(app.getHttpServer()).post('/product-choice').send({}).expect(401);
  });
});
