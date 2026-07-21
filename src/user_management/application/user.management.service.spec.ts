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
import { ApiAppEntity } from '../../entity/api.app.entity';
import { ApiCredentialEntity } from '../../entity/api.credential.entity';
import { ApiCustomerMappingEntity } from '../../entity/api.customer.mapping.entity';
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
import { UserSettlePeriodConditionEnum } from '../../user/interface/user.settle.period.condition.enum';
import { BadRequestException } from '@nestjs/common';
import { IUserAuthority } from '../../user/interface/user.authority';
import { IUserStatus } from '../../user/interface/user.status';
import { IExternalApiSsgRequestStatus } from '../../external_api/interface/external.api.ssg.request.status';
import { IUserBusinessType } from '../../user/interface/user.business.type';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ConfigService } from '@nestjs/config';
import { WalletLedgerService } from '../../wallet/application/wallet-ledger.service';
import { WalletAccountResolverService } from '../../wallet/application/wallet-account-resolver.service';
import { WalletCutoverConfig, WalletCutoverMode } from '../../wallet/config/wallet-cutover.config';
import { WalletResourceType } from '../../wallet/interface/wallet-resource-type';
import { AccountStatusTransitionService } from '../../account_lifecycle/application/account.status.transition.service';
import { SettleService } from '../../settle/application/settle.service';
import { OrderFromService } from '../../order_from/application/order.from.service';
import { SettlementCodeAdminService } from '../../wallet/application/settlement-code-admin.service';
import { UserManagementChargeBalanceReqDto, UserManagementModifyBalanceReqDto } from '../api/user.management.req.dto';

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
  let walletAccountRepository: any;
  let apiAppRepository: any;
  let apiCredentialRepository: any;
  let apiCustomerMappingRepository: any;

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
        {
          provide: SettlementCodeAdminService,
          useValue: {
            classifyJoin: jest.fn().mockResolvedValue({ mode: 'PENDING' }),
            ensureSettlementCodeWallet: jest.fn(),
          },
        },
        { provide: PasswordBcryptEncrypt, useValue: passwordEncrypt },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: {
            ...userRepository,
            ...createMockRepositoryMethod(),
            createQueryBuilder: jest.fn(() => queryBuilder),
            // @Transactional cls 매니저 대용 — chargeBalance/modifyBalance 가 this.userRepository.manager 를
            // resolveByUserId/recordTransaction 2번째 인자(manager)로 전달(스프레드로 유실되는 lazy proxy 보강).
            manager: {},
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
        {
          provide: getRepositoryToken(ApiAppEntity),
          useValue: { ...createMockRepositoryMethod(), softRemove: jest.fn() },
        },
        { provide: getRepositoryToken(ApiCredentialEntity), useValue: createMockRepositoryMethod() },
        {
          provide: getRepositoryToken(ApiCustomerMappingEntity),
          useValue: { ...createMockRepositoryMethod(), softRemove: jest.fn() },
        },
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
        {
          provide: WalletLedgerService,
          useValue: {
            recordTransaction: jest
              .fn()
              .mockResolvedValue({ transactionId: 'tx-1', balanceAfter: 0, isDuplicate: false }),
          },
        },
        {
          provide: WalletAccountResolverService,
          useValue: { resolveByUserId: jest.fn().mockResolvedValue({ id: 'wallet-1' }) },
        },
        // 기본 LEGACY — mirror 테스트에서 per-test 로 WALLET 로 변경
        {
          provide: WalletCutoverConfig,
          useValue: { pr2DeliveryLifecycleMode: WalletCutoverMode.LEGACY, pr3SettleMode: WalletCutoverMode.LEGACY },
        },
        {
          provide: AccountStatusTransitionService,
          useValue: { logAccountCreate: jest.fn(), adminSetStatus: jest.fn(), touchLastActivity: jest.fn() },
        },
        {
          provide: SettleService,
          useValue: { getRemainServiceAmountByUserId: jest.fn().mockResolvedValue(0) },
        },
        {
          provide: OrderFromService,
          useValue: {
            resolveApprovedDefaultPhone: jest.fn().mockResolvedValue(null),
            seedApprovedDefaultPhone: jest.fn(),
          },
        },
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
    walletAccountRepository = module.get(getRepositoryToken(WalletAccountEntity));
    apiAppRepository = module.get(getRepositoryToken(ApiAppEntity));
    apiCredentialRepository = module.get(getRepositoryToken(ApiCredentialEntity));
    apiCustomerMappingRepository = module.get(getRepositoryToken(ApiCustomerMappingEntity));
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

  describe('generateApiKey dual-write (api_app/api_credential) 테스트', () => {
    beforeEach(() => {
      userRepository.findOne.mockResolvedValue({ ...UserEntityTest(), id: 1 });
      // save 는 전달 엔티티를 그대로 반환(app.id 사용 경로 보장)
      apiAppRepository.save.mockImplementation((a: any) => Promise.resolve({ id: 'app-1', ...a }));
      apiAppRepository.create.mockImplementation((a: any) => a);
      apiCredentialRepository.create.mockImplementation((c: any) => c);
      apiCredentialRepository.save.mockImplementation((c: any) => Promise.resolve(c));
      apiCredentialRepository.update.mockResolvedValue({ affected: 0 });
    });

    it('신규 발급 시 api_app + api_credential 을 생성한다', async () => {
      // 신규 account 경로
      (sut as any).externalApiAccountRepository.findOne.mockResolvedValue(null);
      (sut as any).externalApiAccountRepository.save.mockResolvedValue({ id: 'acc-1' });
      apiAppRepository.findOne.mockResolvedValue(null);

      const rawKey = await sut.generateApiKey(1);

      expect(rawKey).toEqual(expect.any(String));
      // 레거시 account 보존
      expect((sut as any).externalApiAccountRepository.save).toHaveBeenCalled();
      // 신규 app 생성
      expect(apiAppRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceAccountId: 'acc-1',
          defaultBillingUserId: 1,
          isActive: true,
          ssgEnabled: false,
        }),
      );
      // app 룩업은 sourceAccountId(account.id) 결정적 축
      expect(apiAppRepository.findOne).toHaveBeenCalledWith({
        where: { sourceAccountId: 'acc-1' },
        withDeleted: true,
      });
      // 신규 credential 생성(활성)
      expect(apiCredentialRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ apiAppId: 'app-1', isActive: true }),
      );
      expect(apiCredentialRepository.save).toHaveBeenCalled();
    });

    it('키회전(재발급) 시 기존 credential 을 비활성화하고 app 속성을 보존한다', async () => {
      (sut as any).externalApiAccountRepository.findOne.mockResolvedValue({ id: 'acc-1', userId: 1 });
      (sut as any).externalApiAccountRepository.save.mockResolvedValue({ id: 'acc-1' });
      // 기존 app: SSG/재발송 설정이 채워져 있음 → 보존되어야 한다
      apiAppRepository.findOne.mockResolvedValue({
        id: 'app-1',
        sourceAccountId: 'acc-1',
        defaultBillingUserId: 1,
        isActive: false,
        ssgEnabled: true,
        resendMaxCount: 5,
        requireExternalCustomerId: true,
        deletedAt: new Date(),
      });

      await sut.generateApiKey(1);

      // app 룩업은 sourceAccountId(account.id) 결정적 축
      expect(apiAppRepository.findOne).toHaveBeenCalledWith({
        where: { sourceAccountId: 'acc-1' },
        withDeleted: true,
      });

      // app 속성 보존: ssgEnabled/resendMaxCount 덮어쓰지 않음, 재활성화만
      expect(apiAppRepository.create).not.toHaveBeenCalled();
      expect(apiAppRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'app-1',
          isActive: true,
          ssgEnabled: true,
          resendMaxCount: 5,
          requireExternalCustomerId: true,
          deletedAt: null,
        }),
      );
      // 기존 활성 credential 비활성화(키회전)
      expect(apiCredentialRepository.update).toHaveBeenCalledWith(
        { apiAppId: 'app-1', isActive: true },
        expect.objectContaining({ isActive: false }),
      );
      // 신규 credential 추가
      expect(apiCredentialRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ apiAppId: 'app-1', isActive: true }),
      );
    });
  });

  describe('다중키/회전 credential 관리 (PR2 Phase 6) 테스트', () => {
    beforeEach(() => {
      apiAppRepository.findOne.mockResolvedValue({ id: 'app-1', sourceAccountId: 'acc-1' });
      apiCredentialRepository.create.mockImplementation((c: any) => c);
      apiCredentialRepository.save.mockImplementation((c: any) => Promise.resolve({ id: 'cred-new', ...c }));
      apiCredentialRepository.update.mockResolvedValue({ affected: 1 });
    });

    it('issueCredential: 기존 활성키 유지하며 추가 credential 발급(평문 1회), deactivate 미호출(다중키)', async () => {
      const res = await sut.issueCredential('acc-1');
      expect(res.apiKey).toEqual(expect.any(String));
      expect(res.credentialId).toBe('cred-new');
      expect(apiCredentialRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ apiAppId: 'app-1', isActive: true }),
      );
      expect(apiCredentialRepository.update).not.toHaveBeenCalled();
    });

    it('issueCredential: app 미존재 → 예외', async () => {
      apiAppRepository.findOne.mockResolvedValue(null);
      await expect(sut.issueCredential('acc-x')).rejects.toThrow();
    });

    it('listCredentials: credential 메타 목록 반환(raw key 미노출)', async () => {
      apiCredentialRepository.find.mockResolvedValue([
        { id: 'c1', apiKeyHash: 'h1', isActive: true, issuedAt: new Date(), revokedAt: null },
        { id: 'c2', apiKeyHash: 'h2', isActive: false, issuedAt: new Date(), revokedAt: new Date() },
      ]);
      const res = await sut.listCredentials('acc-1');
      expect(res).toHaveLength(2);
      expect(res[0]).toEqual(expect.objectContaining({ id: 'c1', isActive: true }));
      expect((res[0] as any).apiKeyHash).toBeUndefined();
    });

    it('revokeCredential: 특정 credential 비활성화', async () => {
      apiCredentialRepository.findOne.mockResolvedValue({ id: 'c1', apiAppId: 'app-1', isActive: true });
      await sut.revokeCredential('acc-1', 'c1');
      expect(apiCredentialRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c1', isActive: false, revokedAt: expect.any(Date) }),
      );
    });

    it('revokeCredential: 이미 회수된 credential → 멱등 no-op(save 미호출)', async () => {
      apiCredentialRepository.findOne.mockResolvedValue({ id: 'c1', apiAppId: 'app-1', isActive: false });
      await sut.revokeCredential('acc-1', 'c1');
      expect(apiCredentialRepository.save).not.toHaveBeenCalled();
    });

    it('revokeCredential: 미존재 credential → 예외', async () => {
      apiCredentialRepository.findOne.mockResolvedValue(null);
      await expect(sut.revokeCredential('acc-1', 'cX')).rejects.toThrow();
    });

    it('rotateCredential: 기존 활성 전부 회수 + 신규 발급(평문 1회)', async () => {
      const res = await sut.rotateCredential('acc-1');
      expect(apiCredentialRepository.update).toHaveBeenCalledWith(
        { apiAppId: 'app-1', isActive: true },
        expect.objectContaining({ isActive: false }),
      );
      expect(apiCredentialRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ apiAppId: 'app-1', isActive: true }),
      );
      expect(res.apiKey).toEqual(expect.any(String));
    });
  });

  describe('고객 매핑 CRUD (PR2 Phase 7) 테스트', () => {
    beforeEach(() => {
      apiAppRepository.findOne.mockResolvedValue({ id: 'app-1', sourceAccountId: 'acc-1' });
      userRepository.findOne.mockResolvedValue({ id: 99, status: IUserStatus.USED });
      apiCustomerMappingRepository.create.mockImplementation((m: any) => m);
      apiCustomerMappingRepository.save.mockImplementation((m: any) => Promise.resolve({ id: 'map-1', ...m }));
      apiCustomerMappingRepository.findOne.mockResolvedValue(null);
    });

    it('createCustomerMapping: billingUser 검증 후 매핑 생성', async () => {
      const res = await sut.createCustomerMapping('acc-1', { externalCustomerId: 'wisead-c1', billingUserId: 99 });
      expect(res).toEqual(
        expect.objectContaining({ apiAppId: 'app-1', externalCustomerId: 'wisead-c1', billingUserId: 99 }),
      );
      expect(apiCustomerMappingRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ apiAppId: 'app-1', externalCustomerId: 'wisead-c1', billingUserId: 99 }),
      );
    });

    it('createCustomerMapping: 활성 중복(externalCustomerId) → 409 Conflict', async () => {
      apiCustomerMappingRepository.findOne.mockResolvedValue({ id: 'existing', apiAppId: 'app-1' });
      await expect(
        sut.createCustomerMapping('acc-1', { externalCustomerId: 'dup', billingUserId: 99 }),
      ).rejects.toThrow();
      expect(apiCustomerMappingRepository.save).not.toHaveBeenCalled();
    });

    it('createCustomerMapping: 비활성(LEAVE) billingUser → 거부', async () => {
      userRepository.findOne.mockResolvedValue({ id: 99, status: IUserStatus.LEAVE });
      await expect(
        sut.createCustomerMapping('acc-1', { externalCustomerId: 'c', billingUserId: 99 }),
      ).rejects.toThrow();
    });

    it('createCustomerMapping: 미존재 billingUser → 거부', async () => {
      userRepository.findOne.mockResolvedValue(null);
      await expect(
        sut.createCustomerMapping('acc-1', { externalCustomerId: 'c', billingUserId: 99 }),
      ).rejects.toThrow();
    });

    it('createCustomerMapping: ER_DUP_ENTRY(동시성) → 409 Conflict', async () => {
      apiCustomerMappingRepository.save.mockRejectedValue({ code: 'ER_DUP_ENTRY' });
      await expect(
        sut.createCustomerMapping('acc-1', { externalCustomerId: 'race', billingUserId: 99 }),
      ).rejects.toThrow();
    });

    it('listCustomerMappings: app 의 매핑 목록 반환', async () => {
      apiCustomerMappingRepository.find.mockResolvedValue([
        { id: 'm1', apiAppId: 'app-1', externalCustomerId: 'c1', billingUserId: 99 },
      ]);
      const res = await sut.listCustomerMappings('acc-1');
      expect(res).toHaveLength(1);
      expect(res[0]).toEqual(expect.objectContaining({ id: 'm1', billingUserId: 99 }));
    });

    it('updateCustomerMapping: billingUserId 변경', async () => {
      apiCustomerMappingRepository.findOne.mockResolvedValue({
        id: 'm1',
        apiAppId: 'app-1',
        externalCustomerId: 'c1',
        billingUserId: 1,
      });
      const res = await sut.updateCustomerMapping('acc-1', 'm1', { billingUserId: 99 });
      expect(res.billingUserId).toBe(99);
      expect(apiCustomerMappingRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'm1', billingUserId: 99 }),
      );
    });

    it('updateCustomerMapping: 미존재 매핑 → 거부', async () => {
      apiCustomerMappingRepository.findOne.mockResolvedValue(null);
      await expect(sut.updateCustomerMapping('acc-1', 'mX', { billingUserId: 99 })).rejects.toThrow();
    });

    it('deleteCustomerMapping: soft-delete', async () => {
      apiCustomerMappingRepository.findOne.mockResolvedValue({ id: 'm1', apiAppId: 'app-1' });
      await sut.deleteCustomerMapping('acc-1', 'm1');
      expect(apiCustomerMappingRepository.softRemove).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
    });

    it('deleteCustomerMapping: 미존재 매핑 → 거부', async () => {
      apiCustomerMappingRepository.findOne.mockResolvedValue(null);
      await expect(sut.deleteCustomerMapping('acc-1', 'mX')).rejects.toThrow();
    });

    it('app 미존재 → 거부 (404 + errorCode=API_APP_NOT_FOUND)', async () => {
      apiAppRepository.findOne.mockResolvedValue(null);
      await expect(sut.listCustomerMappings('acc-x')).rejects.toMatchObject({
        status: 404,
        response: { errorCode: 'API_APP_NOT_FOUND', message: 'API 앱을 찾을 수 없습니다.' },
      });
    });
  });

  describe('requireExternalCustomerId (매핑 필수 모드) 토글/메타 테스트', () => {
    it('updateApiKeySettings: 토글 → app 에 반영, legacy account 에는 미기록(app 전용)', async () => {
      const account: any = { id: 'acc-1', isActive: true, ssgEnabled: false, resendMaxCount: null };
      (sut as any).externalApiAccountRepository.findOne.mockResolvedValue(account);
      (sut as any).externalApiAccountRepository.save.mockImplementation((a: any) => Promise.resolve(a));
      apiAppRepository.findOne.mockResolvedValue({
        id: 'app-1',
        sourceAccountId: 'acc-1',
        requireExternalCustomerId: false,
      });
      apiAppRepository.save.mockImplementation((a: any) => Promise.resolve(a));

      await sut.updateApiKeySettings('acc-1', { requireExternalCustomerId: true } as any);

      expect(apiAppRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'app-1', requireExternalCustomerId: true }),
      );
      // app 전용 플래그 → legacy account 엔티티에는 기록되지 않는다
      expect(account).not.toHaveProperty('requireExternalCustomerId');
    });

    it('updateApiKeySettings: app 미존재 + 플래그 전달 → API_APP_NOT_FOUND (조용히 no-op 금지)', async () => {
      (sut as any).externalApiAccountRepository.findOne.mockResolvedValue({ id: 'acc-1' });
      (sut as any).externalApiAccountRepository.save.mockImplementation((a: any) => Promise.resolve(a));
      apiAppRepository.findOne.mockResolvedValue(null);

      await expect(sut.updateApiKeySettings('acc-1', { requireExternalCustomerId: true } as any)).rejects.toMatchObject(
        { status: 404, response: { errorCode: 'API_APP_NOT_FOUND' } },
      );
    });

    it('getApiKeyInfo: app.requireExternalCustomerId 를 응답에 노출', async () => {
      (sut as any).externalApiAccountRepository.findOne.mockResolvedValue({
        id: 'acc-1',
        isActive: true,
        ssgEnabled: false,
        resendMaxCount: null,
        allowedIps: [],
      });
      apiAppRepository.findOne.mockResolvedValue({ id: 'app-1', requireExternalCustomerId: true });

      const res = await sut.getApiKeyInfo(1);
      expect(res).toMatchObject({ exists: true, requireExternalCustomerId: true });
    });

    it('getApiKeyInfo: app 미존재 → requireExternalCustomerId=false', async () => {
      (sut as any).externalApiAccountRepository.findOne.mockResolvedValue({
        id: 'acc-1',
        isActive: true,
        ssgEnabled: false,
        resendMaxCount: null,
        allowedIps: [],
      });
      apiAppRepository.findOne.mockResolvedValue(null);

      const res = await sut.getApiKeyInfo(1);
      expect(res.requireExternalCustomerId).toBe(false);
    });
  });

  describe('approveSsgRequest app.ssgEnabled 미러 테스트', () => {
    it('승인 시 api_app.ssgEnabled=true 로 미러 저장한다', async () => {
      const ssgRepo = (sut as any).externalApiSsgRequestRepository;
      ssgRepo.findOne.mockResolvedValue({
        id: 'req-1',
        accountId: 'acc-1',
        status: IExternalApiSsgRequestStatus.PENDING,
      });
      ssgRepo.save.mockImplementation((r: any) => Promise.resolve(r));
      (sut as any).externalApiAccountRepository.findOne.mockResolvedValue({ id: 'acc-1', userId: 1 });
      (sut as any).externalApiAccountRepository.save.mockResolvedValue({ id: 'acc-1' });
      userRepository.findOne.mockResolvedValue({ id: 10, personName: '관리자' });
      apiAppRepository.findOne.mockResolvedValue({
        id: 'app-1',
        sourceAccountId: 'acc-1',
        defaultBillingUserId: 1,
        ssgEnabled: false,
      });
      apiAppRepository.save.mockImplementation((a: any) => Promise.resolve(a));

      await sut.approveSsgRequest('req-1', 10);

      // SSG 게이트 SoT = api_app.ssgEnabled → 승인 시 app 에 미러
      expect(apiAppRepository.findOne).toHaveBeenCalledWith({ where: { sourceAccountId: 'acc-1' } });
      expect(apiAppRepository.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'app-1', ssgEnabled: true }));
    });
  });

  describe('addAllowedIpByUserId apiAppId 적재 테스트', () => {
    it('신규 IP 행에 해석된 apiAppId 를 채운다 (app 기준 IP 검사용)', async () => {
      const accountRepo = (sut as any).externalApiAccountRepository;
      const ipRepo = (sut as any).externalApiAllowedIpRepository;
      accountRepo.findOne.mockResolvedValue({ id: 'acc-1', userId: 1 });
      ipRepo.count.mockResolvedValue(0);
      ipRepo.findOne.mockResolvedValue(null);
      ipRepo.create.mockImplementation((e: any) => e);
      ipRepo.save.mockResolvedValue({ id: 'ip-1' });
      apiAppRepository.findOne.mockResolvedValue({ id: 'app-1', sourceAccountId: 'acc-1', defaultBillingUserId: 1 });

      const result = await sut.addAllowedIpByUserId(1, { ip: '1.2.3.4', description: null } as any);

      expect(result).toEqual({ id: 'ip-1' });
      expect(ipRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'acc-1', apiAppId: 'app-1', ipAddress: '1.2.3.4' }),
      );
      // apiAppId 해석은 sourceAccountId(account.id) 결정적 축
      expect(apiAppRepository.findOne).toHaveBeenCalledWith({ where: { sourceAccountId: 'acc-1' } });
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

// settleMethod SoT 동기화 — 메인 describe 와 동일한 NestJS Testing Module 재사용
describe('settleMethod SoT 동기화 테스트', () => {
  let sut: UserManagementService;
  let userRepository: any;
  let userCompanyRepository: any;
  let walletAccountRepository: any;
  let walletResolver: any;
  let walletCutoverConfig: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserManagementService,
        {
          provide: SettlementCodeAdminService,
          useValue: {
            classifyJoin: jest.fn().mockResolvedValue({ mode: 'PENDING' }),
            ensureSettlementCodeWallet: jest.fn(),
          },
        },
        { provide: PasswordBcryptEncrypt, useValue: { encrypt: jest.fn().mockResolvedValue('hashed') } },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: {
            ...createMockRepositoryMethod(),
            manager: {},
            createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
          },
        },
        { provide: getRepositoryToken(UserCompanyEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(UserViewScopeEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(DepartmentEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(ExternalApiAccountEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(ExternalApiAllowedIpEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(ExternalApiSsgRequestEntity), useValue: createMockRepositoryMethod() },
        {
          provide: getRepositoryToken(ApiAppEntity),
          useValue: { ...createMockRepositoryMethod(), softRemove: jest.fn() },
        },
        { provide: getRepositoryToken(ApiCredentialEntity), useValue: createMockRepositoryMethod() },
        {
          provide: getRepositoryToken(ApiCustomerMappingEntity),
          useValue: { ...createMockRepositoryMethod(), softRemove: jest.fn() },
        },
        { provide: getRepositoryToken(WalletAccountEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(WalletTransactionEntity), useValue: createMockRepositoryMethod() },
        { provide: 'IMailSend', useValue: { send: jest.fn() } },
        { provide: 'DeliveryAlimTalk', useValue: { send: jest.fn() } },
        { provide: 'ISmsSend', useValue: { send: jest.fn() } },
        {
          provide: ActivityLogService,
          useValue: {
            createLog: jest.fn().mockResolvedValue(1),
            getBalanceHistoryByUserId: jest.fn(),
            getMaximumLimitHistoryByUserId: jest.fn(),
          },
        },
        { provide: ConfigService, useValue: { getOrThrow: jest.fn().mockReturnValue('CODE') } },
        { provide: WalletLedgerService, useValue: { recordTransaction: jest.fn().mockResolvedValue({}) } },
        {
          provide: WalletAccountResolverService,
          useValue: { resolveByUserId: jest.fn().mockResolvedValue({ id: 'wallet-1', settleMethod: 'CASH' }) },
        },
        {
          provide: WalletCutoverConfig,
          useValue: { pr2DeliveryLifecycleMode: WalletCutoverMode.LEGACY, pr3SettleMode: WalletCutoverMode.LEGACY },
        },
        {
          provide: AccountStatusTransitionService,
          useValue: { logAccountCreate: jest.fn(), adminSetStatus: jest.fn(), touchLastActivity: jest.fn() },
        },
        { provide: SettleService, useValue: { getRemainServiceAmountByUserId: jest.fn().mockResolvedValue(0) } },
        {
          provide: OrderFromService,
          useValue: {
            resolveApprovedDefaultPhone: jest.fn().mockResolvedValue(null),
            seedApprovedDefaultPhone: jest.fn(),
          },
        },
      ],
    }).compile();

    sut = module.get(UserManagementService);
    userRepository = module.get(getRepositoryToken(UserEntity));
    userCompanyRepository = module.get(getRepositoryToken(UserCompanyEntity));
    walletAccountRepository = module.get(getRepositoryToken(WalletAccountEntity));
    walletResolver = module.get(WalletAccountResolverService);
    walletCutoverConfig = module.get(WalletCutoverConfig);
  });

  const baseUpdateBody = {
    id: 1,
    bankName: '',
    bankNumber: '',
    businessAddress: '',
    businessName: 'Biz',
    businessNumber: '1234567890',
    businessPhoneNumber: '',
    cardName: '',
    cardNumber: '',
    corporateNumber: null,
    ip: null,
    maximumLimit: 0,
    personEmail: '',
    personName: '',
    personPhoneNumber: '',
    settleCondition: IUserSettleCondition.POST_PAYMENT,
    authority: IUserAuthority.SUPER_ADMIN,
    status: IUserStatus.USED,
    businessType: IUserBusinessType.CORPORATE,
    authorityList: [],
    allowedSendMethods: [],
  };

  it('update: LEGACY 모드 — company.settleMethod 동기화, wallet 미호출', async () => {
    walletCutoverConfig.pr3SettleMode = WalletCutoverMode.LEGACY;
    const company = { id: 10, businessNumber: '1234567890', settleMethod: 'CASH' };
    userRepository.findOne.mockResolvedValue({
      ...UserEntityTest(),
      id: 1,
      company,
      companyId: 10,
      status: IUserStatus.USED,
    });
    userCompanyRepository.findOne.mockResolvedValue(company);

    await sut.update({ ...baseUpdateBody, settleMethod: IUserSettleMethod.CARD } as any);

    expect(userCompanyRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ settleMethod: IUserSettleMethod.CARD }),
    );
    expect(walletResolver.resolveByUserId).not.toHaveBeenCalled();
  });

  it('update: WALLET 모드 — company.settleMethod + wallet_account.settleMethod 동기화', async () => {
    walletCutoverConfig.pr3SettleMode = WalletCutoverMode.WALLET;
    const walletAccount = { id: 'wallet-1', settleMethod: 'CASH' };
    walletResolver.resolveByUserId.mockResolvedValue(walletAccount);

    const company = { id: 10, businessNumber: '1234567890', settleMethod: 'CASH' };
    userRepository.findOne.mockResolvedValue({
      ...UserEntityTest(),
      id: 1,
      company,
      companyId: 10,
      status: IUserStatus.USED,
    });
    userCompanyRepository.findOne.mockResolvedValue(company);

    await sut.update({ ...baseUpdateBody, settleMethod: IUserSettleMethod.CARD } as any);

    expect(walletResolver.resolveByUserId).toHaveBeenCalledWith(1);
    expect(walletAccountRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ settleMethod: IUserSettleMethod.CARD }),
    );
  });

  it('update: WALLET 모드 — wallet 미존재 시 예외 throw (fail-closed)', async () => {
    walletCutoverConfig.pr3SettleMode = WalletCutoverMode.WALLET;
    walletResolver.resolveByUserId.mockRejectedValue(new Error('wallet not found'));

    const company = { id: 10, businessNumber: '1234567890', settleMethod: 'CASH' };
    userRepository.findOne.mockResolvedValue({
      ...UserEntityTest(),
      id: 1,
      company,
      companyId: 10,
      status: IUserStatus.USED,
    });
    userCompanyRepository.findOne.mockResolvedValue(company);

    await expect(sut.update({ ...baseUpdateBody, settleMethod: IUserSettleMethod.CARD } as any)).rejects.toThrow(
      'wallet not found',
    );
  });

  it('update: 정산조건/정산방법/최대한도/정산기준 미전송 → 기존값 보존 + wallet/company 미오염', async () => {
    walletCutoverConfig.pr3SettleMode = WalletCutoverMode.WALLET;
    const company = { id: 10, businessNumber: '1234567890', settleMethod: 'CASH', maximumLimit: 500 };
    userRepository.findOne.mockResolvedValue({
      ...UserEntityTest(),
      id: 1,
      company,
      companyId: 10,
      status: IUserStatus.USED,
      settleCondition: IUserSettleCondition.PRE_PAYMENT,
      settleMethod: IUserSettleMethod.CARD,
      settlePeriodCondition: UserSettlePeriodConditionEnum.NEXT_MONTH,
      settlePeriodCount: 15,
    });
    userCompanyRepository.findOne.mockResolvedValue(company);

    // 계정 페이지 read-only 전환 후 프론트가 보내는 형태: 정산 편집 필드 전부 미포함.
    const { settleCondition: _sc, maximumLimit: _ml, ...bodyWithoutSettle } = baseUpdateBody as any;
    await sut.update(bodyWithoutSettle as any);

    const savedUser = userRepository.save.mock.calls.at(-1)?.[0];
    // user NOT NULL 정산 필드 보존
    expect(savedUser.settleCondition).toBe(IUserSettleCondition.PRE_PAYMENT);
    expect(savedUser.settleMethod).toBe(IUserSettleMethod.CARD);
    // 정산기준(정산주기) 보존
    expect(savedUser.settlePeriodCondition).toBe(UserSettlePeriodConditionEnum.NEXT_MONTH);
    expect(savedUser.settlePeriodCount).toBe(15);
    // settleMethod 미전송 → wallet_account 정본 동기화 미호출(오염 방지)
    expect(walletResolver.resolveByUserId).not.toHaveBeenCalled();
    expect(walletAccountRepository.save).not.toHaveBeenCalled();
    // 동일 사업자번호 경로: company 는 저장되지만 settleMethod/maximumLimit 은 미변경 보존
    expect(userCompanyRepository.save).toHaveBeenCalled();
    const savedCompany = userCompanyRepository.save.mock.calls.at(-1)?.[0];
    expect(savedCompany.settleMethod).toBe('CASH');
    expect(savedCompany.maximumLimit).toBe(500);
  });

  it('create: LEGACY 모드 — 신규 company에 settleMethod 포함 저장', async () => {
    walletCutoverConfig.pr3SettleMode = WalletCutoverMode.LEGACY;
    userRepository.count.mockResolvedValue(0);
    userRepository.insert.mockResolvedValue({ identifiers: [{ id: 1 }] });
    userCompanyRepository.findOne.mockResolvedValue(null);
    userCompanyRepository.save.mockResolvedValue({ id: 10 });

    await sut.create({
      ...baseUpdateBody,
      email: 'new@test.com',
      password: 'pw123456',
      settleMethod: IUserSettleMethod.CASH,
      fromPhoneNumber: null,
      settlePeriodCondition: null,
      settlePeriodCount: null,
      loginVerifyMethod: null,
    } as any);

    expect(userCompanyRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ settleMethod: IUserSettleMethod.CASH }),
    );
  });

  it('create: 기존 company 연결 시 company.settleMethod 변경 안 함 (타 계정 보호)', async () => {
    walletCutoverConfig.pr3SettleMode = WalletCutoverMode.LEGACY;
    userRepository.count.mockResolvedValue(0);
    userRepository.insert.mockResolvedValue({ identifiers: [{ id: 1 }] });
    userCompanyRepository.findOne.mockResolvedValue({ id: 10, businessNumber: '1234567890', settleMethod: 'CASH' });

    await sut.create({
      ...baseUpdateBody,
      email: 'new@test.com',
      password: 'pw123456',
      settleMethod: IUserSettleMethod.CARD,
      fromPhoneNumber: null,
      settlePeriodCondition: null,
      settlePeriodCount: null,
      loginVerifyMethod: null,
    } as any);

    expect(userCompanyRepository.save).not.toHaveBeenCalled();
  });

  describe('getDetail — settleMethod 표시 SoT (선택값 불러오기)', () => {
    const company = { id: 10, businessNumber: '1234567890', settleMethod: 'CASH' };

    it('WALLET 모드: wallet_account.settleMethod(SoT) 반환, user.settleMethod(deprecated) 무시', async () => {
      walletCutoverConfig.pr3SettleMode = WalletCutoverMode.WALLET;
      walletAccountRepository.findOne.mockResolvedValue({ settleMethod: 'CARD' });
      userRepository.findOne.mockResolvedValue({
        ...UserEntityTest(),
        id: 1,
        settlementCode: 'company-1',
        settleMethod: IUserSettleMethod.CASH,
        company,
        companyId: 10,
      });

      const result = await sut.getDetail({ id: 1 } as any);

      expect(result.settleMethod).toBe('CARD');
      expect(walletAccountRepository.findOne).toHaveBeenCalledWith({
        where: { ownerType: 'SETTLEMENT_CODE', ownerId: 'company-1' },
      });
    });

    it('WALLET 모드: settlement_code 有 + wallet 조회 실패 → fail-closed(throw), user 폴백 금지', async () => {
      walletCutoverConfig.pr3SettleMode = WalletCutoverMode.WALLET;
      walletAccountRepository.findOne.mockResolvedValue(null);
      userRepository.findOne.mockResolvedValue({
        ...UserEntityTest(),
        id: 1,
        settlementCode: 'company-1',
        settleMethod: IUserSettleMethod.CASH,
        company,
        companyId: 10,
      });

      await expect(sut.getDetail({ id: 1 } as any)).rejects.toThrow('wallet_account not found');
    });

    it('WALLET 모드: settlement_code 미부여(PENDING) → user.settleMethod 폴백, wallet 미호출', async () => {
      walletCutoverConfig.pr3SettleMode = WalletCutoverMode.WALLET;
      userRepository.findOne.mockResolvedValue({
        ...UserEntityTest(),
        id: 1,
        settlementCode: '',
        settleMethod: IUserSettleMethod.CASH,
        company,
        companyId: 10,
      });

      const result = await sut.getDetail({ id: 1 } as any);

      expect(result.settleMethod).toBe(IUserSettleMethod.CASH);
      expect(walletAccountRepository.findOne).not.toHaveBeenCalled();
    });

    it('SHADOW 모드: wallet 조회 실패 시 company.settleMethod 폴백', async () => {
      walletCutoverConfig.pr3SettleMode = WalletCutoverMode.SHADOW;
      walletAccountRepository.findOne.mockResolvedValue(null);
      userRepository.findOne.mockResolvedValue({
        ...UserEntityTest(),
        id: 1,
        settlementCode: 'company-1',
        settleMethod: IUserSettleMethod.CARD,
        company: { ...company, settleMethod: 'CASH' },
        companyId: 10,
      });

      const result = await sut.getDetail({ id: 1 } as any);

      expect(result.settleMethod).toBe('CASH');
    });

    it('LEGACY 모드: company.settleMethod 우선, wallet 미호출', async () => {
      walletCutoverConfig.pr3SettleMode = WalletCutoverMode.LEGACY;
      userRepository.findOne.mockResolvedValue({
        ...UserEntityTest(),
        id: 1,
        settleMethod: IUserSettleMethod.CARD,
        company: { ...company, settleMethod: 'CASH' },
        companyId: 10,
      });

      const result = await sut.getDetail({ id: 1 } as any);

      expect(result.settleMethod).toBe('CASH');
      expect(walletResolver.resolveByUserId).not.toHaveBeenCalled();
    });
  });

  describe('getDetail — 여신 현재 사용액(creditUsedAmount)', () => {
    const company = { id: 10, businessNumber: '1234567890', settleMethod: 'CASH' };

    it('wallet 존재: settlement_code 로 조회한 wallet_account.credit_used_amount 를 반환', async () => {
      walletCutoverConfig.pr3SettleMode = WalletCutoverMode.WALLET;
      walletAccountRepository.findOne.mockResolvedValue({ creditUsedAmount: 123_456 });
      userRepository.findOne.mockResolvedValue({
        ...UserEntityTest(),
        id: 1,
        settlementCode: 'company-1',
        company,
        companyId: 10,
      });

      const result = await sut.getDetail({ id: 1 } as any);

      expect(result.creditUsedAmount).toBe(123_456);
      expect(walletAccountRepository.findOne).toHaveBeenCalledWith({
        where: { ownerType: 'SETTLEMENT_CODE', ownerId: 'company-1' },
      });
    });

    it('wallet row 미존재(비-WALLET 모드): 조회는 하되 creditUsedAmount = 0', async () => {
      walletCutoverConfig.pr3SettleMode = WalletCutoverMode.LEGACY;
      walletAccountRepository.findOne.mockResolvedValue(null);
      userRepository.findOne.mockResolvedValue({
        ...UserEntityTest(),
        id: 1,
        settlementCode: 'company-1',
        company,
        companyId: 10,
      });

      const result = await sut.getDetail({ id: 1 } as any);

      expect(result.creditUsedAmount).toBe(0);
      expect(walletAccountRepository.findOne).toHaveBeenCalledWith({
        where: { ownerType: 'SETTLEMENT_CODE', ownerId: 'company-1' },
      });
    });

    it('settlement_code 미부여(PENDING): wallet 조회 없이 creditUsedAmount = 0', async () => {
      walletCutoverConfig.pr3SettleMode = WalletCutoverMode.WALLET;
      userRepository.findOne.mockResolvedValue({
        ...UserEntityTest(),
        id: 1,
        settlementCode: '',
        company,
        companyId: 10,
      });

      const result = await sut.getDetail({ id: 1 } as any);

      expect(result.creditUsedAmount).toBe(0);
      expect(walletAccountRepository.findOne).not.toHaveBeenCalled();
    });
  });
});

describe('modifyMaximumLimit — wallet credit_limit 동기화', () => {
  let sut: UserManagementService;
  let userRepository: any;
  let userCompanyRepository: any;
  let walletAccountRepository: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserManagementService,
        {
          provide: SettlementCodeAdminService,
          useValue: {
            classifyJoin: jest.fn().mockResolvedValue({ mode: 'PENDING' }),
            ensureSettlementCodeWallet: jest.fn(),
          },
        },
        { provide: PasswordBcryptEncrypt, useValue: { encrypt: jest.fn().mockResolvedValue('hashed') } },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: {
            ...createMockRepositoryMethod(),
            manager: {},
            createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
          },
        },
        { provide: getRepositoryToken(UserCompanyEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(UserViewScopeEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(DepartmentEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(ExternalApiAccountEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(ExternalApiAllowedIpEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(ExternalApiSsgRequestEntity), useValue: createMockRepositoryMethod() },
        {
          provide: getRepositoryToken(ApiAppEntity),
          useValue: { ...createMockRepositoryMethod(), softRemove: jest.fn() },
        },
        { provide: getRepositoryToken(ApiCredentialEntity), useValue: createMockRepositoryMethod() },
        {
          provide: getRepositoryToken(ApiCustomerMappingEntity),
          useValue: { ...createMockRepositoryMethod(), softRemove: jest.fn() },
        },
        { provide: getRepositoryToken(WalletAccountEntity), useValue: createMockRepositoryMethod() },
        { provide: getRepositoryToken(WalletTransactionEntity), useValue: createMockRepositoryMethod() },
        { provide: 'IMailSend', useValue: { send: jest.fn() } },
        { provide: 'DeliveryAlimTalk', useValue: { send: jest.fn() } },
        { provide: 'ISmsSend', useValue: { send: jest.fn() } },
        {
          provide: ActivityLogService,
          useValue: { createLog: jest.fn().mockResolvedValue(1), getMaximumLimitHistoryByUserId: jest.fn() },
        },
        { provide: ConfigService, useValue: { getOrThrow: jest.fn().mockReturnValue('CODE') } },
        { provide: WalletLedgerService, useValue: { recordTransaction: jest.fn().mockResolvedValue({}) } },
        { provide: WalletAccountResolverService, useValue: { resolveByUserId: jest.fn() } },
        {
          provide: WalletCutoverConfig,
          useValue: { pr2DeliveryLifecycleMode: WalletCutoverMode.WALLET, pr3SettleMode: WalletCutoverMode.WALLET },
        },
        {
          provide: AccountStatusTransitionService,
          useValue: { logAccountCreate: jest.fn(), adminSetStatus: jest.fn(), touchLastActivity: jest.fn() },
        },
        { provide: SettleService, useValue: { getRemainServiceAmountByUserId: jest.fn().mockResolvedValue(0) } },
        {
          provide: OrderFromService,
          useValue: {
            resolveApprovedDefaultPhone: jest.fn().mockResolvedValue(null),
            seedApprovedDefaultPhone: jest.fn(),
          },
        },
      ],
    }).compile();

    sut = module.get(UserManagementService);
    userRepository = module.get(getRepositoryToken(UserEntity));
    userCompanyRepository = module.get(getRepositoryToken(UserCompanyEntity));
    walletAccountRepository = module.get(getRepositoryToken(WalletAccountEntity));
  });

  const operator = { id: 99, email: 'op@test.com' } as any;

  it('company.maximumLimit 와 wallet.creditLimit 를 함께 갱신한다', async () => {
    const company = { id: 10, maximumLimit: 5_000_000, businessName: 'Biz' };
    userRepository.findOne.mockResolvedValue({
      ...UserEntityTest(),
      id: 103,
      email: 'u@test.com',
      company,
      companyId: 10,
      settlementCode: 'company-10',
    });
    const wallet = { id: 'wallet-1', ownerType: 'SETTLEMENT_CODE', ownerId: 'company-10', creditLimit: 5_000_000 };
    walletAccountRepository.findOne.mockResolvedValue(wallet);

    await sut.modifyMaximumLimit({ id: 103, newMaximumLimit: 20_000_000, memo: '한도 상향' } as any, operator);

    expect(userCompanyRepository.save).toHaveBeenCalledWith(expect.objectContaining({ maximumLimit: 20_000_000 }));
    expect(walletAccountRepository.findOne).toHaveBeenCalledWith({
      where: { ownerType: 'SETTLEMENT_CODE', ownerId: 'company-10' },
    });
    expect(walletAccountRepository.save).toHaveBeenCalledWith(expect.objectContaining({ creditLimit: 20_000_000 }));
  });

  it('wallet 미존재 시에도 company.maximumLimit 갱신은 진행한다', async () => {
    const company = { id: 11, maximumLimit: 1_000_000, businessName: 'Biz2' };
    userRepository.findOne.mockResolvedValue({
      ...UserEntityTest(),
      id: 104,
      company,
      companyId: 11,
      settlementCode: 'company-11',
    });
    walletAccountRepository.findOne.mockResolvedValue(null);

    await sut.modifyMaximumLimit({ id: 104, newMaximumLimit: 3_000_000, memo: null } as any, operator);

    expect(userCompanyRepository.save).toHaveBeenCalledWith(expect.objectContaining({ maximumLimit: 3_000_000 }));
    expect(walletAccountRepository.save).not.toHaveBeenCalled();
  });

  it('settlement_code 미부여 계정은 wallet 조회 없이 company.maximumLimit 만 갱신한다', async () => {
    const company = { id: 12, maximumLimit: 0, businessName: 'Biz3' };
    userRepository.findOne.mockResolvedValue({
      ...UserEntityTest(),
      id: 105,
      company,
      companyId: 12,
      settlementCode: '',
    });

    await sut.modifyMaximumLimit({ id: 105, newMaximumLimit: 7_000_000, memo: null } as any, operator);

    expect(userCompanyRepository.save).toHaveBeenCalledWith(expect.objectContaining({ maximumLimit: 7_000_000 }));
    expect(walletAccountRepository.findOne).not.toHaveBeenCalled();
    expect(walletAccountRepository.save).not.toHaveBeenCalled();
  });
  it('R-modLimit: 회사에 NON-EMPTY 정산코드가 2개 이상이면 400 (per-code 엔드포인트 안내)', async () => {
    const company = { id: 20, maximumLimit: 1_000_000, businessName: 'MultiBiz' };
    userRepository.findOne.mockResolvedValue({
      ...UserEntityTest(),
      id: 201,
      company,
      companyId: 20,
      settlementCode: 'company-20',
    });
    // DISTINCT NON-EMPTY 코드 2개 반환.
    userRepository.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ code: 'company-20' }, { code: 'company-20-1' }]),
    } as any);

    await expect(
      sut.modifyMaximumLimit({ id: 201, newMaximumLimit: 9_000_000, memo: null } as any, operator),
    ).rejects.toThrow(/정산코드가 2개 이상/);
    expect(userCompanyRepository.save).not.toHaveBeenCalled();
    expect(walletAccountRepository.save).not.toHaveBeenCalled();
  });

  it('R-modLimit: NON-EMPTY 코드 1개(+ PENDING "" 혼재) 회사는 허용', async () => {
    const company = { id: 21, maximumLimit: 1_000_000, businessName: 'SingleBiz' };
    userRepository.findOne.mockResolvedValue({
      ...UserEntityTest(),
      id: 202,
      company,
      companyId: 21,
      settlementCode: 'company-21',
    });
    // 쿼리가 ''/NULL 을 제외하므로 실제 코드 1개만 반환.
    userRepository.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ code: 'company-21' }]),
    } as any);
    walletAccountRepository.findOne.mockResolvedValue({
      id: 'w-21',
      ownerType: 'SETTLEMENT_CODE',
      ownerId: 'company-21',
      creditLimit: 1_000_000,
    });

    await sut.modifyMaximumLimit({ id: 202, newMaximumLimit: 4_000_000, memo: null } as any, operator);
    expect(userCompanyRepository.save).toHaveBeenCalledWith(expect.objectContaining({ maximumLimit: 4_000_000 }));
  });
});
