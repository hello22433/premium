import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ErpController } from './erp.controller';
import { ErpProductService } from '../application/erp.product.service';
import { AuthUserSuperAndOperationAdminGuard } from '../../auth/api/auth.user.super-operation-admin.guard';
import { IUserAuthority } from '../../user/interface/user.authority';

/**
 * ERP 품목조회 입력 길이/허용값 검증 회귀 테스트 (audit #41).
 *
 * 목록 prodCd/from/toProdCd 뿐 아니라 단건 :prodCd, 양쪽 prodType 까지
 * 길이·허용값 제한 없이 ecount API 로 중계되던 우회로를 막는다.
 * 가드(자사직원)는 통과시키고(OPERATION_ADMIN 토큰) ValidationPipe 로 400 을 확인한다.
 */
describe('ErpController 입력 검증 (HTTP)', () => {
  let app: INestApplication;

  const erpProductService = {
    getProductsList: jest.fn().mockResolvedValue({ Status: 200, Error: null, Data: null }),
    getProduct: jest.fn().mockResolvedValue({ Status: 200, Error: null, Data: null }),
  };
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
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const admin = `Bearer ${IUserAuthority.OPERATION_ADMIN}`;

  describe('과도한 길이는 400 으로 차단된다', () => {
    it('목록 prodType 51자 → 400', async () => {
      await request(app.getHttpServer())
        .get('/erp/products')
        .query({ prodType: '1'.repeat(51) })
        .set('Authorization', admin)
        .expect(400);
    });

    it('단건 :prodCd 21자 → 400', async () => {
      await request(app.getHttpServer())
        .get(`/erp/products/${'A'.repeat(21)}`)
        .set('Authorization', admin)
        .expect(400);
    });

    it('단건 prodType 51자 → 400', async () => {
      await request(app.getHttpServer())
        .get('/erp/products/P001')
        .query({ prodType: '1'.repeat(51) })
        .set('Authorization', admin)
        .expect(400);
    });
  });

  describe('허용되지 않은 값은 400 으로 차단된다', () => {
    it('목록 prodType 비숫자 → 400', async () => {
      await request(app.getHttpServer())
        .get('/erp/products')
        .query({ prodType: 'abc' })
        .set('Authorization', admin)
        .expect(400);
    });

    it('단건 prodType 비숫자 → 400', async () => {
      await request(app.getHttpServer())
        .get('/erp/products/P001')
        .query({ prodType: 'abc' })
        .set('Authorization', admin)
        .expect(400);
    });

    // ecount 미정의 코드(5/6/8/9) 및 잘못된 구분 형식 (문자 화이트리스트만으론 통과하던 케이스)
    it.each(['5', '6', '8', '9', '33', '3∬', '∬3', '3∬∬4'])('목록 prodType=%s → 400', async (prodType) => {
      await request(app.getHttpServer())
        .get('/erp/products')
        .query({ prodType })
        .set('Authorization', admin)
        .expect(400);
    });
  });

  describe('정상 입력은 통과한다', () => {
    it('단건 유효 prodCd + prodType=3 → 200', async () => {
      await request(app.getHttpServer())
        .get('/erp/products/P001')
        .query({ prodType: '3' })
        .set('Authorization', admin)
        .expect(200);

      expect(erpProductService.getProduct).toHaveBeenCalled();
    });

    it('목록 prodType=3∬4 (∬ 다중) → 200', async () => {
      await request(app.getHttpServer())
        .get('/erp/products')
        .query({ prodType: '3∬4' })
        .set('Authorization', admin)
        .expect(200);
    });
  });
});
