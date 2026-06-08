// chargeBalance/modifyBalance 는 @Transactional() — 단위 테스트에서 데코레이터를 no-op 으로 mock 한다.
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (_target: unknown, _key: unknown, _descriptor: unknown) => _descriptor,
  Propagation: { REQUIRED: 'REQUIRED', REQUIRES_NEW: 'REQUIRES_NEW' },
  initializeTransactionalContext: jest.fn(),
  addTransactionalDataSources: jest.fn(),
}));

import { mock, mockReset } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { UserEntity } from '../../entity/user.entity';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import { UserViewScopeEntity } from '../../entity/user.view.scope.entity';
import { DepartmentEntity } from '../../entity/department.entity';
import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';
import { ExternalApiAllowedIpEntity } from '../../entity/external.api.allowed.ip.entity';
import { ExternalApiSsgRequestEntity } from '../../entity/external.api.ssg.request.entity';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { UserManagementService } from './user.management.service';
import { createMockQueryBuilder } from '../../common/test/mock.query.builder';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createMockRepositoryMethod } from '../../common/test/mock.repository.method';
import {
  UserManagementGetListReqQueryDto,
  UserManagementModifyMaximumLimitReqDto,
} from '../api/user.management.req.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UserEntityTest } from '../../../test/infra/user.entity.test';
import { PasswordBcryptEncrypt } from '../../auth/infrastructure/password.bcrypt.encrypt';
import { IUserSettleCondition } from '../../user/interface/user.settle.condition';
import { IUserSettleMethod } from '../../user/interface/user.settle.method';
import { BadRequestException } from '@nestjs/common';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserStatus } from '../../user/interface/user.status';
import { IUserBusinessType } from '../../user/interface/user.business.type';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ConfigService } from '@nestjs/config';
import { WalletLedgerService } from '../../wallet/application/wallet-ledger.service';
import { WalletAccountResolverService } from '../../wallet/application/wallet-account-resolver.service';
import { WalletCutoverConfig, WalletCutoverMode } from '../../wallet/config/wallet-cutover.config';
import { WalletResourceType } from '../../wallet/interface/wallet-resource-type';
import {
  UserManagementChargeBalanceReqDto,
  UserManagementModifyBalanceReqDto,
} from '../api/user.management.req.dto';

describe('user management service test', () => {
  let userRepository: any = mock<Repository<UserEntity>>();
  let userCompanyRepository: any;
  let passwordEncrypt: any = mock<PasswordBcryptEncrypt>();
  let queryBuilder: any = createMockQueryBuilder();

  let sut: UserManagementService;
  let activityLogService: any;
  let walletLedger: any;
  let walletResolver: any;
  let walletCutoverConfig: any;

  const CORPORATE_ADMIN_USER = { id: 5, email: 'corp@test.com', authority: IUserAuthority.CORPORATE_ADMIN };
  const OPERATION_ADMIN_USER = { id: 10, email: 'op@test.com', authority: IUserAuthority.OPERATION_ADMIN };
  const SUPER_ADMIN_USER = { id: 1, email: 'super@test.com', authority: IUserAuthority.SUPER_ADMIN };

  beforeEach(async () => {
    queryBuilder = createMockQueryBuilder();
    // 잔액 UPDATE 체인 (update/set/where/setParameters/execute) — balance 충전/수정/차감 경로용
    queryBuilder.update = jest.fn().mockReturnThis();
    queryBuilder.set = jest.fn().mockReturnThis();
    queryBuilder.setParameters = jest.fn().mockReturnThis();
    queryBuilder.execute = jest.fn().mockResolvedValue({ affected: 1 });
    mockReset(userRepository);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserManagementService,
        { provide: PasswordBcryptEncrypt, useValue: passwordEncrypt },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: {
            ...userRepository,
            ...createMockRepositoryMethod(),
            createQueryBuilder: jest.fn(() => queryBuilder),
          },
        },
        {
          provide: getRepositoryToken(UserCompanyEntity),
          useValue: { ...createMockRepositoryMethod(), createQueryBuilder: jest.fn(() => queryBuilder) },
        },
        { provide: getRepositoryToken(UserViewScopeEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(DepartmentEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(ExternalApiAccountEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(ExternalApiAllowedIpEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(ExternalApiSsgRequestEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(WalletAccountEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(WalletTransactionEntity), useValue: createMockRepositoryMethod() },
        { provide: 'IMailSend', useValue: { send: jest.fn() } },
        { provide: 'DeliveryAlimTalk', useValue: { send: jest.fn() } },
        { provide: 'ISmsSend', useValue: { send: jest.fn() } },
        {
          provide: ActivityLogService,
          useValue: {
            createLog: jest.fn().mockResolvedValue(777),
            getBalanceHistoryByUserId: jest.fn(),
            getMaximumLimitHistoryByUserId: jest.fn(),
          },
        },
        { provide: ConfigService, useValue: { getOrThrow: jest.fn().mockReturnValue('TEMPLATE_CODE') } },
        { provide: WalletLedgerService, useValue: { recordTransaction: jest.fn().mockResolvedValue({ transactionId: 'tx-1', balanceAfter: 0, isDuplicate: false }) } },
        { provide: WalletAccountResolverService, useValue: { resolveByUserId: jest.fn().mockResolvedValue({ id: 'wallet-1' }) } },
        // 기본 LEGACY — mirror 테스트에서 per-test 로 WALLET 로 변경
        { provide: WalletCutoverConfig, useValue: { pr2DeliveryLifecycleMode: WalletCutoverMode.LEGACY } },
      ],
    }).compile();

    sut = module.get<UserManagementService>(UserManagementService);
    userRepository = module.get<Repository<UserEntity>>(getRepositoryToken(UserEntity));
    userCompanyRepository = module.get(getRepositoryToken(UserCompanyEntity));
    passwordEncrypt = module.get<PasswordBcryptEncrypt>(PasswordBcryptEncrypt);
    activityLogService = module.get(ActivityLogService);
    walletLedger = module.get(WalletLedgerService);
    walletResolver = module.get(WalletAccountResolverService);
    walletCutoverConfig = module.get(WalletCutoverConfig);
  });

  describe('getList 리스트 조회 테스트', () => {
    it('성공적으로 조회한 경우', async () => {
      const givenGetBody: UserManagementGetListReqQueryDto = {
        page: 1,
        take: 10,
      };

      queryBuilder.getManyAndCount.mockResolvedValue([[{ ...UserEntityTest(), id: 1 }], 1]);

      const result = await sut.getList(givenGetBody);

      expect(result.list[0].id).toBe(1);
      expect(result.totalPage).toBe(1);
      expect(result.totalCount).toBe(1);
    });
  });

  describe('create 유저 생성 테스트', () => {
    it('생성에 성공한 경우', async () => {
      const givenGetBody = {
        bankName: '',
        bankNumber: '',
        businessAddress: '',
        businessName: '',
        businessNumber: '',
        businessPhoneNumber: '',
        cardName: '',
        cardNumber: '',
        corporateNumber: null,
        email: '',
        ip: null,
        maximumLimit: 0,
        password: 'test1234',
        personEmail: '',
        personName: '',
        personPhoneNumber: '',
        settleCondition: IUserSettleCondition.POST_PAYMENT,
        settleMethod: IUserSettleMethod.CARD,
        authority: IUserAuthority.SUPER_ADMIN,
        businessType: IUserBusinessType.CORPORATE,
        authorityList: [],
        allowedSendMethods: [],
      };
      userRepository.count.mockResolvedValue(0);
      userRepository.insert.mockResolvedValue({ identifiers: [{ id: 1 }] });

      await sut.create(givenGetBody as any);

      expect(userRepository.insert).toHaveBeenCalled();
      expect(passwordEncrypt.encrypt).toHaveBeenCalledWith('test1234');
    });

    it('중복된 이메일이 존재하여 계정 생성에 실패한 경우', async () => {
      const givenGetBody = {
        bankName: '',
        bankNumber: '',
        businessAddress: '',
        businessName: '',
        businessNumber: '',
        businessPhoneNumber: '',
        cardName: '',
        cardNumber: '',
        corporateNumber: null,
        email: '',
        ip: null,
        maximumLimit: 0,
        password: 'test1234',
        personEmail: '',
        personName: '',
        personPhoneNumber: '',
        settleCondition: IUserSettleCondition.POST_PAYMENT,
        settleMethod: IUserSettleMethod.CARD,
        authority: IUserAuthority.CORPORATE_ADMIN,
        businessType: IUserBusinessType.CORPORATE,
      };
      userRepository.count.mockResolvedValue(1);

      await expect(async () => {
        await sut.create(givenGetBody as any);
      }).rejects.toThrow(new BadRequestException('중복된 이메일 입니다.'));
    });
  });

  describe('update 테스트', () => {
    it('업데이트에 성공한 경우 테스트', async () => {
      const givenUpdateBody = {
        id: 1,
        bankName: 'New Bank',
        bankNumber: '123-456-789',
        businessAddress: 'New Address',
        businessName: 'Updated Business',
        businessNumber: '1234567890',
        businessPhoneNumber: '010-1234-5678',
        cardName: 'Updated Card',
        cardNumber: '9876-5432-1098-7654',
        corporateNumber: '123456-7890123',
        ip: '192.168.0.1',
        maximumLimit: 1000000,
        personEmail: 'person@example.com',
        personName: 'Updated Person',
        personPhoneNumber: '010-9876-5432',
        settleCondition: IUserSettleCondition.POST_PAYMENT,
        settleMethod: IUserSettleMethod.CARD,
        authority: IUserAuthority.SUPER_ADMIN,
        status: IUserStatus.USED,
        businessType: IUserBusinessType.CORPORATE,
        authorityList: [],
        allowedSendMethods: [],
      };

      userRepository.findOne.mockResolvedValue({
        ...UserEntityTest(),
        id: 1,
        personName: 'Old Person',
        personPhoneNumber: '010-1111-2222',
        personEmail: 'oldperson@example.com',
      });
      userCompanyRepository.findOne.mockResolvedValue({ id: 10, businessNumber: '1234567890' });

      await sut.update(givenUpdateBody as any);

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1 },
        relations: ['company'],
      });
      expect(userRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 1,
          personName: 'Updated Person',
          personPhoneNumber: '010-9876-5432',
          // businessName: 'Updated Business',
        }),
      );
    });

    it('user 가 없어 실패한 경우', async () => {
      const givenUpdateBody = {
        id: 1,
        bankName: 'New Bank',
        bankNumber: '123-456-789',
        businessAddress: 'New Address',
        businessName: 'Updated Business',
        businessNumber: '1234567890',
        businessPhoneNumber: '010-1234-5678',
        cardName: 'Updated Card',
        cardNumber: '9876-5432-1098-7654',
        corporateNumber: '123456-7890123',
        ip: '192.168.0.1',
        maximumLimit: 1000000,
        personEmail: 'person@example.com',
        personName: 'Updated Person',
        personPhoneNumber: '010-9876-5432',
        settleCondition: IUserSettleCondition.POST_PAYMENT,
        settleMethod: IUserSettleMethod.CARD,
        authority: IUserAuthority.SUPER_ADMIN,
        status: IUserStatus.USED,
        businessType: IUserBusinessType.CORPORATE,
        authorityList: [],
        allowedSendMethods: [],
      };

      userRepository.findOne.mockResolvedValue(null);

      await expect(async () => {
        await sut.update(givenUpdateBody as any);
      }).rejects.toThrow(new BadRequestException('유저가 존재하지 않습니다.'));

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1 },
        relations: ['company'],
      });
      expect(userRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('getCompanyList 권한별 필터 테스트', () => {
    it('CORPORATE_ADMIN: own companyId 필터 적용', async () => {
      userRepository.findOne.mockResolvedValue({ companyId: 10 });

      await sut.getCompanyList({ page: 1, take: 10 }, CORPORATE_ADMIN_USER);

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('company.id = :companyId', { companyId: 10 });
    });

    it('CORPORATE_ADMIN: businessName 검색 시 companyId + businessName 필터 모두 적용', async () => {
      userRepository.findOne.mockResolvedValue({ companyId: 10 });

      await sut.getCompanyList({ page: 1, take: 10, businessName: '테스트' }, CORPORATE_ADMIN_USER);

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('company.id = :companyId', { companyId: 10 });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('company.businessName LIKE :businessName', {
        businessName: '%테스트%',
      });
    });

    it('OPERATION_ADMIN: companyId 필터 없음', async () => {
      await sut.getCompanyList({ page: 1, take: 10 }, OPERATION_ADMIN_USER);

      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith('company.id = :companyId', expect.anything());
    });

    it('SUPER_ADMIN: companyId 필터 없음', async () => {
      await sut.getCompanyList({ page: 1, take: 10 }, SUPER_ADMIN_USER);

      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith('company.id = :companyId', expect.anything());
    });
  });

  describe('getNameList 권한별 필터 테스트', () => {
    it('CORPORATE_ADMIN: 자기 id로만 필터링', async () => {
      await sut.getNameList({}, CORPORATE_ADMIN_USER);

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('user.id = :id', { id: 5 });
    });

    it('OPERATION_ADMIN: 전체 조회, user.id 필터 없음', async () => {
      await sut.getNameList({}, OPERATION_ADMIN_USER);

      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith('user.id = :id', expect.anything());
    });

    it('SUPER_ADMIN: 전체 조회, user.id 필터 없음', async () => {
      await sut.getNameList({}, SUPER_ADMIN_USER);

      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith('user.id = :id', expect.anything());
    });
  });

  describe('예치금 충전/수정 wallet 미러 테스트', () => {
    const OPERATOR = { id: 99, email: 'op@test.com' } as any;

    const mockAccountUser = (balance: number) =>
      userRepository.findOne.mockResolvedValue({
        id: 1,
        email: 'u@test.com',
        balance,
        company: { id: 10, businessName: 'b', balanceManagementType: 'ACCOUNT' },
      });

    it('WALLET 모드: 충전 시 wallet DEPOSIT +chargeAmount 미러 (key=balance_charge:{logId}:deposit)', async () => {
      walletCutoverConfig.pr2DeliveryLifecycleMode = WalletCutoverMode.WALLET;
      mockAccountUser(1000);
      activityLogService.createLog.mockResolvedValue(777);

      await sut.chargeBalance({ id: 1, chargeAmount: 5000, memo: 'm' } as any, OPERATOR);

      expect(walletResolver.resolveByUserId).toHaveBeenCalledWith(1, expect.anything());
      expect(walletLedger.recordTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          walletAccountId: 'wallet-1',
          resourceType: WalletResourceType.DEPOSIT,
          amount: 5000,
          type: 'BALANCE_CHARGE',
          idempotencyKey: 'balance_charge:777:deposit',
        }),
        expect.anything(),
      );
    });

    it('WALLET 모드: 수정 +delta → wallet DEPOSIT +delta 미러', async () => {
      walletCutoverConfig.pr2DeliveryLifecycleMode = WalletCutoverMode.WALLET;
      mockAccountUser(1000);
      activityLogService.createLog.mockResolvedValue(777);

      await sut.modifyBalance({ id: 1, newBalance: 3000 } as any, OPERATOR);

      expect(walletLedger.recordTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 2000,
          type: 'BALANCE_MODIFY',
          idempotencyKey: 'balance_modify:777:deposit',
        }),
        expect.anything(),
      );
    });

    it('WALLET 모드: 수정 -delta → wallet DEPOSIT 음수 미러', async () => {
      walletCutoverConfig.pr2DeliveryLifecycleMode = WalletCutoverMode.WALLET;
      mockAccountUser(1000);

      await sut.modifyBalance({ id: 1, newBalance: 200 } as any, OPERATOR);

      expect(walletLedger.recordTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ amount: -800, type: 'BALANCE_MODIFY' }),
        expect.anything(),
      );
    });

    it('WALLET 모드: 수정 delta=0 → 미러 skip', async () => {
      walletCutoverConfig.pr2DeliveryLifecycleMode = WalletCutoverMode.WALLET;
      mockAccountUser(1000);

      await sut.modifyBalance({ id: 1, newBalance: 1000 } as any, OPERATOR);

      expect(walletLedger.recordTransaction).not.toHaveBeenCalled();
    });

    it('LEGACY 모드: 충전 시 wallet 미호출 (legacy only)', async () => {
      walletCutoverConfig.pr2DeliveryLifecycleMode = WalletCutoverMode.LEGACY;
      mockAccountUser(1000);

      await sut.chargeBalance({ id: 1, chargeAmount: 5000 } as any, OPERATOR);

      expect(walletResolver.resolveByUserId).not.toHaveBeenCalled();
      expect(walletLedger.recordTransaction).not.toHaveBeenCalled();
    });

    it('WALLET 모드: wallet 미존재(resolve throw) → 충전 reject (tx rollback = fail-closed)', async () => {
      walletCutoverConfig.pr2DeliveryLifecycleMode = WalletCutoverMode.WALLET;
      mockAccountUser(1000);
      walletResolver.resolveByUserId.mockRejectedValue(new BadRequestException('settlement_code missing'));

      await expect(sut.chargeBalance({ id: 1, chargeAmount: 5000 } as any, OPERATOR)).rejects.toThrow();
      expect(walletLedger.recordTransaction).not.toHaveBeenCalled();
    });

    it('WALLET 모드: 수정 음수 delta가 wallet deposit underflow → reject (tx rollback)', async () => {
      walletCutoverConfig.pr2DeliveryLifecycleMode = WalletCutoverMode.WALLET;
      mockAccountUser(1000); // before=1000, newBalance=200 → amount=-800
      walletLedger.recordTransaction.mockRejectedValue(new BadRequestException('deposit_underflow'));

      await expect(sut.modifyBalance({ id: 1, newBalance: 200 } as any, OPERATOR)).rejects.toThrow();
      expect(walletLedger.recordTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ amount: -800, resourceType: WalletResourceType.DEPOSIT }),
        expect.anything(),
      );
    });

    it('WALLET 모드: addBalance(발송 실패 환불)는 미러 미호출 (이중차감 방지)', async () => {
      walletCutoverConfig.pr2DeliveryLifecycleMode = WalletCutoverMode.WALLET;
      mockAccountUser(1000);

      await sut.addBalance(1, 500, 'refund');

      expect(walletLedger.recordTransaction).not.toHaveBeenCalled();
    });

    it('WALLET 모드: deductBalance(재발송 역환불)는 미러 미호출 (이중차감 방지)', async () => {
      walletCutoverConfig.pr2DeliveryLifecycleMode = WalletCutoverMode.WALLET;
      mockAccountUser(1000);
      queryBuilder.execute.mockResolvedValue({ affected: 1 });

      await sut.deductBalance(1, 500, 'resend-reverse');

      expect(walletLedger.recordTransaction).not.toHaveBeenCalled();
    });

    it('회사/계정 balance 모드 모두 같은 billing user(=같은 wallet owner)로 resolve', async () => {
      walletCutoverConfig.pr2DeliveryLifecycleMode = WalletCutoverMode.WALLET;
      // 계정 모드
      mockAccountUser(1000);
      await sut.chargeBalance({ id: 1, chargeAmount: 100 } as any, OPERATOR);
      // 회사 모드
      userRepository.findOne.mockResolvedValue({
        id: 1,
        email: 'u@test.com',
        company: { id: 10, businessName: 'b', balanceManagementType: 'COMPANY' },
      });
      userCompanyRepository.findOne.mockResolvedValue({ id: 10, balance: 1000 });
      await sut.chargeBalance({ id: 1, chargeAmount: 100 } as any, OPERATOR);

      // 두 모드 모두 user id 1 로 resolve → 동일 settlement_code wallet 으로 수렴
      expect(walletResolver.resolveByUserId).toHaveBeenCalledTimes(2);
      expect(walletResolver.resolveByUserId).toHaveBeenNthCalledWith(1, 1, expect.anything());
      expect(walletResolver.resolveByUserId).toHaveBeenNthCalledWith(2, 1, expect.anything());
    });
  });
});

describe('UserManagementModifyMaximumLimitReqDto 검증 테스트', () => {
  it('newMaximumLimit 음수 입력 시 유효성 검사 오류 반환', async () => {
    const dto = plainToInstance(UserManagementModifyMaximumLimitReqDto, { id: 1, newMaximumLimit: -1 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'newMaximumLimit')).toBe(true);
  });

  it('newMaximumLimit 0 입력 시 유효성 검사 통과', async () => {
    const dto = plainToInstance(UserManagementModifyMaximumLimitReqDto, { id: 1, newMaximumLimit: 0 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'newMaximumLimit')).toBe(false);
  });

  it('newMaximumLimit 소수점 입력 시 유효성 검사 오류 반환', async () => {
    const dto = plainToInstance(UserManagementModifyMaximumLimitReqDto, { id: 1, newMaximumLimit: 1.5 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'newMaximumLimit')).toBe(true);
  });

  it('newMaximumLimit MYSQL_INT_MAX 초과 입력 시 유효성 검사 오류 반환', async () => {
    const dto = plainToInstance(UserManagementModifyMaximumLimitReqDto, { id: 1, newMaximumLimit: 2_147_483_648 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'newMaximumLimit')).toBe(true);
  });
});

describe('UserManagementModifyBalanceReqDto 검증 테스트', () => {
  it('newBalance 음수 입력 시 유효성 검사 오류 반환 (wallet underflow 이전 legacy 음수 차단)', async () => {
    const dto = plainToInstance(UserManagementModifyBalanceReqDto, { id: 1, newBalance: -1 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'newBalance')).toBe(true);
  });

  it('newBalance 0 입력 시 유효성 검사 통과', async () => {
    const dto = plainToInstance(UserManagementModifyBalanceReqDto, { id: 1, newBalance: 0 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'newBalance')).toBe(false);
  });

  it('newBalance MYSQL_INT_MAX 초과 입력 시 유효성 검사 오류 반환', async () => {
    const dto = plainToInstance(UserManagementModifyBalanceReqDto, { id: 1, newBalance: 2_147_483_648 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'newBalance')).toBe(true);
  });
});
