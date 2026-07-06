import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { OrderFromController } from './order.from.controller';
import { OrderFromService } from '../application/order.from.service';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { AuthUserSuperAdminGuard } from '../../auth/api/auth.user.super-admin.guard';
import { IUserAuthority } from '../../user/interface/user.authority';

describe('OrderFromController 이메일 발신 설정 인가 가드 (HTTP)', () => {
  let app: INestApplication;

  const orderFromService = {
    getPhoneList: jest.fn(),
    getPhoneManageList: jest.fn(),
    createPhone: jest.fn(),
    getEmailList: jest.fn().mockResolvedValue({ list: [] }),
    createEmail: jest.fn().mockResolvedValue(undefined),
    deleteEmail: jest.fn().mockResolvedValue(undefined),
    setDefault: jest.fn(),
    setHideSystemFromPhone: jest.fn(),
    getAdminList: jest.fn(),
    adminDelete: jest.fn(),
    adminApprove: jest.fn(),
    adminReject: jest.fn(),
    adminUpdateCert: jest.fn(),
  };

  const tokenValidator = {
    validateByToken: jest.fn((token: string) => ({ id: 1, email: 't@test.com', authority: token })),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [OrderFromController],
      providers: [
        { provide: OrderFromService, useValue: orderFromService },
        AuthUserAuthorizationGuard,
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const auth = (role: IUserAuthority) => `Bearer ${role}`;

  it('CORPORATE_ADMIN 은 전역 발신 이메일 등록 API 에 접근할 수 없다', async () => {
    await request(app.getHttpServer())
      .post('/order-from/email')
      .set('Authorization', auth(IUserAuthority.CORPORATE_ADMIN))
      .send({ from: 'sender@example.com' })
      .expect(403);

    expect(orderFromService.createEmail).not.toHaveBeenCalled();
  });

  it('CORPORATE_ADMIN 은 전역 발신 이메일 삭제 API 에 접근할 수 없다', async () => {
    await request(app.getHttpServer())
      .delete('/order-from/email')
      .set('Authorization', auth(IUserAuthority.CORPORATE_ADMIN))
      .send({ id: 1 })
      .expect(403);

    expect(orderFromService.deleteEmail).not.toHaveBeenCalled();
  });

  it('SUPER_ADMIN 은 전역 발신 이메일 등록/삭제 API 에 접근할 수 있다', async () => {
    await request(app.getHttpServer())
      .post('/order-from/email')
      .set('Authorization', auth(IUserAuthority.SUPER_ADMIN))
      .send({ from: 'sender@example.com' })
      .expect(201);

    await request(app.getHttpServer())
      .delete('/order-from/email')
      .set('Authorization', auth(IUserAuthority.SUPER_ADMIN))
      .send({ id: 1 })
      .expect(200);

    expect(orderFromService.createEmail).toHaveBeenCalled();
    expect(orderFromService.deleteEmail).toHaveBeenCalled();
  });

  it('발신 이메일 목록 조회는 기존처럼 인증 사용자에게 허용한다', async () => {
    await request(app.getHttpServer())
      .get('/order-from/email/list')
      .set('Authorization', auth(IUserAuthority.CORPORATE_ADMIN))
      .expect(200);

    expect(orderFromService.getEmailList).toHaveBeenCalled();
  });
});
