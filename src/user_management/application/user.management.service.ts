import { randomBytes, createHash } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { UserEntity } from '../../entity/user.entity';
import { IUserStatus } from '../../user/interface/user.status';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import { UserViewScopeEntity, ViewScopeType } from '../../entity/user.view.scope.entity';
import { DepartmentEntity } from '../../entity/department.entity';
import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';
import { ExternalApiAllowedIpEntity } from '../../entity/external.api.allowed.ip.entity';
import { ExternalApiSsgRequestEntity } from '../../entity/external.api.ssg.request.entity';
import { ApiAppEntity } from '../../entity/api.app.entity';
import { ApiCredentialEntity } from '../../entity/api.credential.entity';
import { ApiCustomerMappingEntity } from '../../entity/api.customer.mapping.entity';
import {
  CreateCustomerMappingReqDto,
  UpdateCustomerMappingReqDto,
  CustomerMappingResDto,
} from '../api/dto/customer.mapping.dto';
import { WalletAccountEntity } from '../../entity/wallet.account.entity';
import { WalletTransactionEntity } from '../../entity/wallet.transaction.entity';
import { WalletResourceType } from '../../wallet/interface/wallet-resource-type';
import { WalletLedgerService } from '../../wallet/application/wallet-ledger.service';
import { WalletAccountResolverService } from '../../wallet/application/wallet-account-resolver.service';
import { WalletCutoverConfig, WalletCutoverMode } from '../../wallet/config/wallet-cutover.config';
import { SettleService } from '../../settle/application/settle.service';
import { IExternalApiSsgRequestStatus } from '../../external_api/interface/external.api.ssg.request.status';
import { Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { InjectRepository } from '@nestjs/typeorm';
import {
  AddAllowedIpReqDto,
  ApiKeyInfoResDto,
  GenerateApiKeyByAdminReqDto,
  GenerateApiKeyReqDto,
  SsgRequestResDto,
  UpdateAllowedIpsReqDto,
  UpdateApiKeySettingsReqDto,
} from '../api/dto/user.management.api.key.dto';
import {
  UserManagementChargeBalanceReqDto,
  UserManagementCreateReqDto,
  UserManagementGetDetailReqParamDto,
  UserManagementGetListReqQueryDto,
  UserManagementGetNameListReqQueryDto,
  UserManagementPasswordResetReqDto,
  UserManagementUpdateReqDto,
  UserManagementModifyBalanceReqDto,
  UserManagementGetCompanyListReqQueryDto,
  UserManagementModifyMaximumLimitReqDto,
  UserManagementChangeEmailReqDto,
} from '../api/user.management.req.dto';
import {
  UserManagementGetDetailResDto,
  UserManagementGetListResDto,
  UserManagementGetNameListResDto,
  UserManagementGetBalanceHistoryResDto,
  BalanceHistoryItemDto,
  UserManagementGetMaximumLimitHistoryResDto,
  MaximumLimitHistoryItemDto,
  UserManagementGetWalletHistoryResDto,
  WalletHistoryItemDto,
} from '../api/user.management.res.dto';
import { UserManagementViewDto } from '../api/dto/user.management.view.dto';
import { PasswordBcryptEncrypt } from '../../auth/infrastructure/password.bcrypt.encrypt';
import { UserManagementNameViewDto } from '../api/dto/user.management.name.view.dto';
import { generateRandomPassword } from '../../user_find/domain/user.password.regex';
import { userResetPasswordTemplate } from '../../user_find/domain/user.reset.password.template.html';
import { IMailSend } from '../../mail/interface/mail-send';
import { UserSettlePeriodConditionEnum } from '../../user/interface/user.settle.period.condition.enum';
import { IUserSettleCondition } from '../../user/interface/user.settle.condition';
import { UserAuthListDefault } from '../../user_info/domain/user.auth.list.default';
import { ActivityLogService } from '../../activity_log/application/activity.log.service';
import { ActivityLogActionType } from '../../activity_log/interface/activity.log.action.type';
import { ActivityLogResult } from '../../activity_log/interface/activity.log.result';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { IUserAuthority } from '../../user/interface/user.authority';
import { ActivityLogEntity } from '../../entity/activity.log.entity';
import { format } from 'date-fns';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { CompanyType } from '../../common/domain/company.type';
import { ConfigService } from '@nestjs/config';
import { AccountStatusTransitionService } from '../../account_lifecycle/application/account.status.transition.service';
import { TransitionSource } from '../../account_lifecycle/interface/transition.source';
import { LoginVerifyMethod } from '../../user/interface/login.verify.method';
import { DeliveryAlimTalk } from '../../delivery/interface/delivery.alim.talk';
import { ISmsSend } from '../../sms/interface/sms.send';
import { defaultFromPhoneNumber } from '../../const';
import { OrderFromService } from '../../order_from/application/order.from.service';
import { SettlementCodeAdminService } from '../../wallet/application/settlement-code-admin.service';

const MYSQL_INT_MAX = 2_147_483_647;

@Injectable()
export class UserManagementService {
  private readonly logger = new Logger('UserManagementService');

  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(UserCompanyEntity)
    private userCompanyRepository: Repository<UserCompanyEntity>,
    @InjectRepository(UserViewScopeEntity)
    private userViewScopeRepository: Repository<UserViewScopeEntity>,
    @InjectRepository(DepartmentEntity)
    private departmentRepository: Repository<DepartmentEntity>,
    @InjectRepository(ExternalApiAccountEntity)
    private externalApiAccountRepository: Repository<ExternalApiAccountEntity>,
    @InjectRepository(ExternalApiAllowedIpEntity)
    private externalApiAllowedIpRepository: Repository<ExternalApiAllowedIpEntity>,
    @InjectRepository(ExternalApiSsgRequestEntity)
    private externalApiSsgRequestRepository: Repository<ExternalApiSsgRequestEntity>,
    @InjectRepository(ApiAppEntity)
    private apiAppRepository: Repository<ApiAppEntity>,
    @InjectRepository(ApiCredentialEntity)
    private apiCredentialRepository: Repository<ApiCredentialEntity>,
    @InjectRepository(ApiCustomerMappingEntity)
    private apiCustomerMappingRepository: Repository<ApiCustomerMappingEntity>,
    @InjectRepository(WalletAccountEntity)
    private walletAccountRepository: Repository<WalletAccountEntity>,
    @InjectRepository(WalletTransactionEntity)
    private walletTransactionRepository: Repository<WalletTransactionEntity>,
    private passwordEncrypt: PasswordBcryptEncrypt,
    @Inject('IMailSend')
    private readonly mailSendService: IMailSend,
    private activityLogService: ActivityLogService,
    @Inject('DeliveryAlimTalk')
    private readonly alimTalkService: DeliveryAlimTalk,
    @Inject('ISmsSend')
    private readonly smsSendService: ISmsSend,
    private readonly configService: ConfigService,
    private readonly walletLedger: WalletLedgerService,
    private readonly walletResolver: WalletAccountResolverService,
    private readonly walletCutoverConfig: WalletCutoverConfig,
    private readonly accountStatusTransitionService: AccountStatusTransitionService,
    private readonly settleService: SettleService,
    private readonly orderFromService: OrderFromService,
    private readonly settlementCodeAdminService: SettlementCodeAdminService,
  ) {}

  private readonly initPasswordTemplateCode = this.configService.getOrThrow<string>(
    'ALIM_TALK_INFO_BANK_INIT_PASSWORD_TEMPLATE_CODE',
  );

  private async sendViaAlimTalkWithSmsFallback(
    to: string,
    text: string,
    templateCode: string,
    fromPhone: string | null,
    logContext: string,
  ): Promise<void> {
    try {
      await this.alimTalkService.send({ to, text, templateCode, msgType: 'AT' });
      this.logger.log(`${logContext} 알림톡 발송 성공`);
    } catch (alimTalkError) {
      this.logger.warn(`${logContext} 알림톡 발송 실패, SMS 대체 발송: ${alimTalkError.message}`);
      try {
        await this.smsSendService.send({
          msgType: 'S',
          to,
          from: fromPhone || defaultFromPhoneNumber,
          subject: '',
          text,
          filePath: [],
        });
        this.logger.log(`${logContext} SMS 발송 성공`);
      } catch (smsError) {
        this.logger.error(`${logContext} SMS 발송 실패: ${smsError.message}`);
        throw new BadRequestException('발송에 실패했습니다. 잠시 후 다시 시도해주세요.');
      }
    }
  }

  /**
   * 회사 레벨 선충전 관리 모드인지 확인
   */
  private isCompanyBalanceMode(company: UserCompanyEntity | null): company is UserCompanyEntity {
    return company?.balanceManagementType === 'COMPANY';
  }

  /**
   * chargeBalance/modifyBalance 용 activity log 공통 필드 조합.
   */
  private buildBalanceLogBase(
    operator: ILoginUserInfo,
    requestUrl: string,
    actionType: string,
    user: UserEntity,
    company: UserCompanyEntity | null,
  ) {
    return {
      userId: operator.id,
      userEmail: operator.email,
      method: 'PUT' as const,
      requestUrl,
      actionType,
      ipAddress: '',
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime: 0,
      requestParams: {
        targetUserId: user.id,
        targetUserEmail: user.email,
        targetBusinessName: company?.businessName ?? '',
        targetCompanyId: company?.id ?? null,
        balanceManagementType: company?.balanceManagementType ?? 'ACCOUNT',
      },
    };
  }

  /**
   * 잔액 행 잠금 (SELECT FOR UPDATE) 후 현재 잔액 반환.
   * 반드시 @Transactional() 컨텍스트 안에서 호출해야 잠금이 유효함.
   */
  private async lockBalance(user: UserEntity, company: UserCompanyEntity | null): Promise<number> {
    if (this.isCompanyBalanceMode(company)) {
      const locked = await this.userCompanyRepository.findOne({
        where: { id: company.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) {
        throw new NotFoundException('잔액 처리 중 회사 정보를 찾을 수 없습니다.');
      }
      return locked.balance;
    }
    const locked = await this.userRepository.findOne({
      where: { id: user.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!locked) {
      throw new NotFoundException('잔액 처리 중 계정 정보를 찾을 수 없습니다.');
    }
    return locked.balance;
  }

  async getNameList(
    getQuery: UserManagementGetNameListReqQueryDto,
    loginUser: ILoginUserInfo,
  ): Promise<UserManagementGetNameListResDto> {
    const { authority } = getQuery;

    let queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.company', 'company')
      .where('user.status = :activeStatus', { activeStatus: IUserStatus.USED });

    if (loginUser.authority === IUserAuthority.CORPORATE_ADMIN) {
      queryBuilder = queryBuilder.andWhere('user.id = :id', { id: loginUser.id });
    }

    if (authority) {
      queryBuilder = queryBuilder.andWhere('user.authority = :authority', { authority });
    }

    const userList = await queryBuilder.getMany();
    const resultList: UserManagementNameViewDto[] = userList.map((user) => {
      return {
        id: user.id,
        businessName: user.company?.businessName ?? '',
        personName: user.personName,
      };
    });

    return { list: resultList };
  }

  async getList(getQuery: UserManagementGetListReqQueryDto): Promise<UserManagementGetListResDto> {
    const {
      searchType,
      searchKeyword,
      settleCondition,
      status,
      createdStartAt,
      createdEndAt,
      email,
      businessName,
      personName,
      personPhoneNumber,
      page,
      take,
    } = getQuery;

    let queryBuilder = this.userRepository.createQueryBuilder('user').leftJoinAndSelect('user.company', 'company');

    if (settleCondition) {
      queryBuilder = queryBuilder.andWhere('user.settleCondition = :settleCondition', { settleCondition });
    }
    if (status) {
      queryBuilder = queryBuilder.andWhere('user.status = :status', { status });
    }

    if (createdStartAt) {
      queryBuilder = queryBuilder.andWhere('user.createdAt >= :createdStartAt', {
        createdStartAt: new Date(createdStartAt),
      });
    }

    if (createdEndAt) {
      queryBuilder = queryBuilder.andWhere('user.createdAt <= :createdEndAt', {
        createdEndAt: new Date(createdEndAt),
      });
    }

    // ===== 통합 검색 (searchType + searchKeyword) =====
    if (searchKeyword && searchKeyword.length >= 1) {
      switch (searchType) {
        case 'email':
          queryBuilder = queryBuilder.andWhere('user.email LIKE :keyword', {
            keyword: `%${searchKeyword}%`,
          });
          break;
        case 'businessName':
          queryBuilder = queryBuilder.andWhere('company.businessName LIKE :keyword', {
            keyword: `%${searchKeyword}%`,
          });
          break;
        case 'personName':
          queryBuilder = queryBuilder.andWhere('user.personName LIKE :keyword', {
            keyword: `%${searchKeyword}%`,
          });
          break;
        case 'personPhoneNumber':
          queryBuilder = queryBuilder.andWhere('user.personPhoneNumber LIKE :keyword', {
            keyword: `%${searchKeyword}%`,
          });
          break;
        // 전체 검색 (아무 값이 들어오지 않으면 전체검색으로 인식)
        default:
          queryBuilder = queryBuilder.andWhere(
            `(user.email LIKE :keyword
              OR company.businessName LIKE :keyword
              OR user.personName LIKE :keyword
              OR user.personPhoneNumber LIKE :keyword)`,
            { keyword: `%${searchKeyword}%` },
          );
          break;
      }
    }

    if (email) {
      queryBuilder = queryBuilder.andWhere('user.email LIKE :email', { email: `%${email}%` });
    }

    if (businessName) {
      queryBuilder = queryBuilder.andWhere('company.businessName LIKE :businessName', {
        businessName: `%${businessName}%`,
      });
    }

    if (personName) {
      queryBuilder = queryBuilder.andWhere('user.personName LIKE :personName', {
        personName: `%${personName}%`,
      });
    }

    if (personPhoneNumber) {
      queryBuilder = queryBuilder.andWhere('user.personPhoneNumber LIKE :personPhoneNumber', {
        personPhoneNumber: `%${personPhoneNumber}%`,
      });
    }

    queryBuilder = queryBuilder.orderBy('user.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.take(take).skip(skip);

    const [userList, totalCount] = await queryBuilder.getManyAndCount();

    const resultList: UserManagementViewDto[] = userList.map((user) => {
      return {
        id: user.id,
        email: user.email,
        personCode: user.personCode,
        businessName: user.company?.businessName ?? '',
        personName: user.personName,
        personPhoneNumber: user.personPhoneNumber,
        settleCondition: user.settleCondition,
        settleMethod: user.settleMethod,
        maximumLimit: user.company?.maximumLimit ?? 0,
        balance: this.getCurrentBalance(user, user.company),
        status: user.status,
        isLoginLocked: user.isLoginLocked,
        duplicatePhoneLimit: user.duplicatePhoneLimit,
      };
    });

    const totalPage = Math.ceil(totalCount / take);

    return { list: resultList, totalCount, totalPage, currentPage: page };
  }

  async getDetail(getParam: UserManagementGetDetailReqParamDto): Promise<UserManagementGetDetailResDto> {
    const { id } = getParam;

    const user = await this.userRepository.findOne({
      where: {
        id,
      },
      relations: ['company', 'department'],
    });

    if (!user) {
      throw new BadRequestException('유저가 존재하지 않습니다.');
    }

    // null 일 경우 기본값 return 하는 함수 생성 필요
    const authorityList = UserAuthListDefault(user.authority, user.authorityList);

    // 사업자 정보는 user_company에서 가져옴
    const company = user.company;

    // 조회 범위 정보 조회
    const viewScope = await this.userViewScopeRepository.findOne({
      where: { userId: id },
    });

    // 대상 계정 기준 잔여 발송 한도/신용초과금 (로그인 본인이 아니라 조회 대상 기준)
    const remain = await this.settleService.getRemainServiceAmountByUserId(id);

    return {
      id: user.id,
      email: user.email,
      isPasswordReset: user.isPasswordReset,
      authority: user.authority,
      status: user.status,
      isLoginLocked: user.isLoginLocked,
      lockedAt: user.lockedAt?.toISOString() ?? null,
      personName: user.personName,
      personPhoneNumber: user.personPhoneNumber,
      personEmail: user.personEmail,
      personCode: user.personCode,
      personCategory: user.personCategory,
      corporateNumber: user.corporateNumber,

      businessType: user.businessType,
      businessNumber: company?.businessNumber ?? '',
      businessName: company?.businessName ?? '',
      businessAddress: company?.businessAddress ?? '',
      businessPhoneNumber: company?.businessPhoneNumber ?? '',
      ip: user.ip,
      settleCondition: user.settleCondition,
      settleMethod: user.settleMethod,
      maximumLimit: company?.maximumLimit ?? 0,

      bankName: user.bankName,
      bankNumber: user.bankNumber,
      cardName: user.cardName,
      cardNumber: user.cardNumber,
      balance: this.getCurrentBalance(user, company),
      fromPhoneNumber:
        process.env.FROM_PHONE_SOT_ENFORCE === 'true'
          ? await this.orderFromService.resolveApprovedDefaultPhone(user.id)
          : user.fromPhoneNumber,

      settlePeriodCondition: user.settlePeriodCondition,
      settlePeriodCount: user.settlePeriodCount,
      duplicatePhoneLimit: user.duplicatePhoneLimit,
      hideSystemFromPhone: user.hideSystemFromPhone,
      authorityList: authorityList,
      industryType: company?.industryType ?? null,
      industryItem: company?.industryItem ?? null,
      documentCompanyType: user.documentCompanyType ?? CompanyType.ENMAD,
      companyId: user.companyId,
      company: company
        ? {
            id: company.id,
            businessName: company.businessName,
            businessNumber: company.businessNumber,
            maximumLimit: company.maximumLimit,
            balance: company.balance,
            balanceManagementType: company.balanceManagementType,
          }
        : null,
      departmentId: user.departmentId,
      department: user.department
        ? {
            id: user.department.id,
            name: user.department.name,
          }
        : null,
      viewScope: viewScope
        ? {
            scopeType: viewScope.scopeType,
            deptIds: viewScope.getDeptIdList(),
          }
        : {
            scopeType: ViewScopeType.SELF,
            deptIds: [],
          },
      allowedSendMethods: user.allowedSendMethods
        ? user.allowedSendMethods.split(',').map((m) => (m === 'SMS' ? 'MMS' : m))
        : ['ALIM_TALK', 'MMS', 'EMAIL'],
      loginVerifyMethod: user.loginVerifyMethod,
      remainServiceAmount: remain.remainServiceAmount,
      creditExcessAmount: remain.creditExcessAmount,
    };
  }

  @Transactional()
  async chargeBalance(getBody: UserManagementChargeBalanceReqDto, operator: ILoginUserInfo) {
    const { id, chargeAmount, memo } = getBody;

    const user = await this.userRepository.findOne({
      where: {
        id,
      },
      relations: ['company'],
    });

    if (!user) {
      throw new BadRequestException('not found user');
    }

    const company = user.company;
    const { beforeBalance, afterBalance } = await this.updateBalance(user, company, chargeAmount);

    const base = this.buildBalanceLogBase(
      operator,
      '/user-management/balance',
      ActivityLogActionType.BALANCE_CHARGE,
      user,
      company,
    );
    const logId = await this.activityLogService.createLog({
      ...base,
      requestParams: {
        ...base.requestParams,
        chargeAmount,
        beforeBalance,
        afterBalance,
        memo: memo || null,
      },
    });

    await this.mirrorDepositToWallet(id, chargeAmount, 'BALANCE_CHARGE', `balance_charge:${logId}:deposit`, memo);
  }

  /**
   * 잔액 업데이트 공통 로직 (회사/계정 레벨 분기 처리)
   * SELECT FOR UPDATE로 행 잠금 후 beforeBalance 기록, atomic UPDATE로 잔액 변경.
   * 호출부에 @Transactional()이 있어야 잠금이 트랜잭션 범위 안에서 동작함.
   */
  private async updateBalance(
    user: UserEntity,
    company: UserCompanyEntity | null,
    amount: number,
  ): Promise<{ beforeBalance: number; afterBalance: number }> {
    const beforeBalance = await this.lockBalance(user, company);

    if (beforeBalance + amount > MYSQL_INT_MAX) {
      throw new BadRequestException('충전 후 잔액이 최대 허용 금액(2,147,483,647)을 초과합니다.');
    }

    const isCompanyMode = this.isCompanyBalanceMode(company);
    const targetRepo = isCompanyMode ? this.userCompanyRepository : this.userRepository;
    const targetId = isCompanyMode ? company.id : user.id;

    await targetRepo
      .createQueryBuilder()
      .update()
      .set({ balance: () => 'balance + :amount' })
      .where('id = :id', { id: targetId })
      .setParameters({ amount })
      .execute();

    return { beforeBalance, afterBalance: beforeBalance + amount };
  }

  @Transactional()
  async modifyBalance(getBody: UserManagementModifyBalanceReqDto, operator: ILoginUserInfo) {
    const { id, newBalance, memo } = getBody;

    const user = await this.userRepository.findOne({
      where: {
        id,
      },
      relations: ['company'],
    });

    if (!user) {
      throw new BadRequestException('not found user');
    }

    const company = user.company;
    const { beforeBalance } = await this.setBalance(user, company, newBalance);
    const changeAmount = newBalance - beforeBalance;

    const base = this.buildBalanceLogBase(
      operator,
      '/user-management/balance/modify',
      ActivityLogActionType.BALANCE_MODIFY,
      user,
      company,
    );
    const logId = await this.activityLogService.createLog({
      ...base,
      requestParams: {
        ...base.requestParams,
        changeAmount,
        beforeBalance,
        afterBalance: newBalance,
        memo: memo || null,
      },
    });

    await this.mirrorDepositToWallet(id, changeAmount, 'BALANCE_MODIFY', `balance_modify:${logId}:deposit`, memo);
  }

  /**
   * 예치금 충전/수정을 wallet_account.deposit_balance 에 미러링한다.
   * WALLET cutover 모드(WALLET_PR2_DELIVERY_LIFECYCLE_MODE=wallet)에서만 동작 — 그 외 모드는 no-op.
   *
   * 선정산(PRE) 회사는 WALLET 모드에서 wallet deposit_balance 를 발송확정 시 예치금 상한으로
   * 직접 읽으므로, 충전이 wallet 에 반영되지 않으면 부족분이 전액 신용초과로 흘러 발송확정이
   * 차단된다 (하드 블로커). 이 미러가 그 간극을 메운다.
   *
   * - resourceType=DEPOSIT, amount=delta (충전 +chargeAmount, 수정 +(newBalance-beforeBalance) 부호 그대로)
   * - idempotencyKey 는 activity_log id 기반 → op 당 유일 → 반복 충전이 정상 누적
   * - this.userRepository.manager = @Transactional cls 트랜잭션 매니저 → recordTransaction same-tx 실행.
   *   wallet 미존재/underflow throw 시 잔액 UPDATE·activity_log INSERT 까지 전체 rollback = fail-closed.
   * - addBalance/deductBalance(발송 실패 환불·재발송 역환불)는 wallet 카운터파트가 이미 존재하므로
   *   미러 대상에서 제외 (이중 차감 방지).
   */
  private async mirrorDepositToWallet(
    userId: number,
    deltaAmount: number,
    type: 'BALANCE_CHARGE' | 'BALANCE_MODIFY',
    idempotencyKey: string,
    memo?: string | null,
  ): Promise<void> {
    if (this.walletCutoverConfig.pr2DeliveryLifecycleMode !== WalletCutoverMode.WALLET) {
      return;
    }
    if (deltaAmount === 0) {
      return;
    }

    const manager = this.userRepository.manager;
    const wallet = await this.walletResolver.resolveByUserId(userId, manager);
    await this.walletLedger.recordTransaction(
      {
        walletAccountId: wallet.id,
        resourceType: WalletResourceType.DEPOSIT,
        amount: deltaAmount,
        type,
        idempotencyKey,
        memo: memo ?? null,
      },
      manager,
    );
  }

  /**
   * 잔액을 특정 값으로 설정하는 공통 로직 (회사/계정 레벨 분기 처리)
   * SELECT FOR UPDATE로 행 잠금 후 beforeBalance 기록, balance 컬럼만 UPDATE.
   * 호출부에 @Transactional()이 있어야 잠금이 트랜잭션 범위 안에서 동작함.
   */
  private async setBalance(
    user: UserEntity,
    company: UserCompanyEntity | null,
    newBalance: number,
  ): Promise<{ beforeBalance: number }> {
    const beforeBalance = await this.lockBalance(user, company);

    if (this.isCompanyBalanceMode(company)) {
      await this.userCompanyRepository.update({ id: company.id }, { balance: newBalance });
    } else {
      await this.userRepository.update({ id: user.id }, { balance: newBalance });
    }

    return { beforeBalance };
  }

  async getBalanceHistory(userId: number): Promise<UserManagementGetBalanceHistoryResDto> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('존재하지 않는 계정입니다.');
    }

    // Activity Log에서 해당 유저의 충전/수정 이력 조회
    const logs = await this.activityLogService.getBalanceHistoryByUserId(userId);

    const list: BalanceHistoryItemDto[] = logs.map((log) => ({
      id: log.id,
      createdAt: format(log.createdAt, DateFormatStr),
      actionType: log.actionType,
      amount:
        log.requestParams?.chargeAmount ?? log.requestParams?.changeAmount ?? log.requestParams?.restoreAmount ?? 0,
      beforeBalance: log.requestParams?.beforeBalance ?? 0,
      afterBalance: log.requestParams?.afterBalance ?? 0,
      operatorEmail: log.userEmail,
      memo: log.requestParams?.memo || null,
    }));

    return { list };
  }

  /**
   * wallet_transaction 기반 이력 조회 (resourceType 별).
   * user.settlement_code → wallet_account(ownerType=SETTLEMENT_CODE, ownerId) → wallet_transaction.
   * 예치금/여신/포인트 이력을 resource_type 으로 분리해 탭별 조회를 지원한다.
   * activity_log 기반 getBalanceHistory(예치금 충전/수정 운영자 이력)와는 별개 데이터 소스.
   */
  async getWalletHistory(
    userId: number,
    resourceType: WalletResourceType,
  ): Promise<UserManagementGetWalletHistoryResDto> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('존재하지 않는 계정입니다.');
    }

    // settlement_code 미부여 계정은 wallet_account 가 없으므로 빈 목록 반환
    if (!user.settlementCode) {
      return { list: [] };
    }

    const walletAccount = await this.walletAccountRepository.findOne({
      where: { ownerType: 'SETTLEMENT_CODE', ownerId: user.settlementCode },
    });
    if (!walletAccount) {
      return { list: [] };
    }

    const transactions = await this.walletTransactionRepository.find({
      where: { walletAccountId: walletAccount.id, resourceType },
      order: { createdAt: 'DESC', id: 'DESC' },
    });

    const list: WalletHistoryItemDto[] = transactions.map((tx) => ({
      id: tx.id,
      createdAt: format(tx.createdAt, DateFormatStr),
      resourceType: tx.resourceType,
      type: tx.type,
      amount: tx.amount,
      balanceAfter: tx.balanceAfter,
      orderId: tx.orderId,
      memo: tx.memo,
    }));

    return { list };
  }

  async getBalance(id: number): Promise<number> {
    const user = await this.userRepository.findOne({
      where: { id },
      relations: ['company'],
    });
    if (!user) {
      throw new BadRequestException('존재하지 않는 계정입니다.');
    }

    return this.getCurrentBalance(user, user.company);
  }

  /**
   * 현재 잔액 조회 (회사/계정 레벨 분기 처리)
   */
  private getCurrentBalance(user: UserEntity, company: UserCompanyEntity | null): number {
    if (this.isCompanyBalanceMode(company)) {
      return company.balance;
    }
    return user.balance;
  }

  /**
   * 잔액 차감 (재발송 시 역환불). atomic conditional UPDATE로 잔액 부족 체크와 차감을 원자적으로 수행.
   */
  @Transactional()
  async deductBalance(id: number, amount: number, memo?: string): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id },
      relations: ['company'],
    });
    if (!user) {
      throw new BadRequestException('존재하지 않는 계정입니다.');
    }

    const company = user.company;
    const isCompanyMode = this.isCompanyBalanceMode(company);
    const targetId = isCompanyMode ? company!.id : user.id;
    const targetRepo = isCompanyMode ? this.userCompanyRepository : this.userRepository;

    const beforeBalance = await this.lockBalance(user, company);

    const result = await targetRepo
      .createQueryBuilder()
      .update()
      .set({ balance: () => 'balance - :amount' })
      .where('id = :id AND balance >= :amount', { id: targetId, amount })
      .setParameters({ amount })
      .execute();

    if (!result.affected) {
      throw new BadRequestException('잔액이 부족합니다.');
    }

    const afterBalance = beforeBalance - amount;

    await this.activityLogService.createLog({
      userId: 0,
      userEmail: 'system@epopkon.com',
      method: 'SYSTEM',
      requestUrl: '/system/balance/refund-reverse',
      actionType: ActivityLogActionType.BALANCE_REFUND_REVERSE,
      ipAddress: '',
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime: 0,
      requestParams: {
        targetUserId: id,
        targetUserEmail: user.email,
        targetBusinessName: company?.businessName ?? '',
        targetCompanyId: company?.id ?? null,
        balanceManagementType: company?.balanceManagementType ?? 'ACCOUNT',
        deductAmount: amount,
        beforeBalance,
        afterBalance,
        memo: memo || '재발송 역환불',
      },
    });
  }

  @Transactional()
  async addBalance(id: number, amount: number, memo?: string): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id },
      relations: ['company'],
    });
    if (!user) {
      throw new BadRequestException('존재하지 않는 계정입니다.');
    }

    const company = user.company;
    const { beforeBalance, afterBalance } = await this.updateBalance(user, company, amount);

    await this.activityLogService.createLog({
      userId: 0,
      userEmail: 'system@epopkon.com',
      method: 'SYSTEM',
      requestUrl: '/system/balance/refund',
      actionType: ActivityLogActionType.BALANCE_REFUND,
      ipAddress: '',
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime: 0,
      requestParams: {
        targetUserId: id,
        targetUserEmail: user.email,
        targetBusinessName: company?.businessName ?? '',
        targetCompanyId: company?.id ?? null,
        balanceManagementType: company?.balanceManagementType ?? 'ACCOUNT',
        chargeAmount: amount,
        beforeBalance,
        afterBalance,
        memo: memo || '시스템 자동 환불',
      },
    });
  }

  /**
   * 발신번호 SoT 동기화. APPROVED isDefault PHONE 보장 + user.fromPhoneNumber mirror 갱신(없으면 NULL).
   * 반드시 호출자의 @Transactional CLS 매니저(this.userRepository.manager)로 실행한다.
   * manager 를 넘기지 않으면 seedApprovedDefaultPhone 이 별도 트랜잭션을 열고, 그 안의
   * reconcileDefaultAndMirror 가 user 행에 SELECT FOR UPDATE 를 걸어 호출자가 이미 잡은
   * user 행 락과 self-deadlock → Lock wait timeout 이 발생한다.
   */
  private async syncFromPhone(userId: number, rawFrom: string | null | undefined): Promise<void> {
    await this.orderFromService.seedApprovedDefaultPhone(userId, rawFrom, this.userRepository.manager, {
      blankPolicy: 'clear-if-no-approved',
    });
  }

  @Transactional()
  async create(getBody: UserManagementCreateReqDto) {
    const isExistEmail = await this.userRepository.count({
      where: {
        email: getBody.email,
      },
    });

    if (isExistEmail) {
      throw new BadRequestException('중복된 이메일 입니다.');
    }

    const passwordEncrypt = await this.passwordEncrypt.encrypt(getBody.password);

    // 사업자등록번호에서 하이픈 제거
    const businessNumber = getBody.businessNumber ? getBody.businessNumber.replace(/-/g, '') : getBody.businessNumber;

    // 동일 사업자등록번호의 회사가 있으면 연결, 없으면 생성
    let companyId: number | null = null;
    // 이번 호출에서 회사 row 를 신규 생성했는지 (settlement_code 배정 판정 기준, S4)
    let isNewCompany = false;
    let newCompanyMaximumLimit = 0;
    if (businessNumber) {
      let existingCompany = await this.userCompanyRepository.findOne({
        where: { businessNumber },
      });

      if (existingCompany) {
        // 기존 회사 연결만 — 공유 회사 settleMethod 변경 금지 (타 계정 정산 영향 방지)
        companyId = existingCompany.id;
      } else {
        // 새 회사 생성
        const newCompany = await this.userCompanyRepository.save({
          businessNumber: businessNumber,
          businessName: getBody.businessName,
          businessAddress: getBody.businessAddress,
          businessPhoneNumber: getBody.businessPhoneNumber,
          industryType: getBody.industryType,
          industryItem: getBody.industryItem,
          maximumLimit: getBody.maximumLimit,
          settleMethod: getBody.settleMethod ?? null,
        });
        companyId = newCompany.id;
        isNewCompany = true;
        newCompanyMaximumLimit = newCompany.maximumLimit;
      }
    }

    const insertResult = await this.userRepository.insert({
      email: getBody.email,
      password: passwordEncrypt,
      authority: getBody.authority,
      personName: getBody.personName,
      personPhoneNumber: getBody.personPhoneNumber,
      personEmail: getBody.personEmail,
      corporateNumber: getBody.corporateNumber,
      businessType: getBody.businessType,
      ip: getBody.ip,
      settleCondition: getBody.settleCondition,
      settleMethod: getBody.settleMethod,
      bankName: getBody.bankName,
      bankNumber: getBody.bankNumber,
      cardName: getBody.cardName,
      cardNumber: getBody.cardNumber,
      status: getBody.status,
      personCode: getBody.email,
      fromPhoneNumber: getBody.fromPhoneNumber,
      settlePeriodCondition: getBody.settlePeriodCondition,
      settlePeriodCount: getBody.settlePeriodCount,
      duplicatePhoneLimit: getBody.duplicatePhoneLimit ?? 0,
      hideSystemFromPhone: getBody.hideSystemFromPhone ?? false,
      authorityList: getBody.authorityList.join(','),
      companyId: companyId,
      allowedSendMethods: getBody.allowedSendMethods.join(','),
      documentCompanyType: getBody.documentCompanyType ?? CompanyType.ENMAD,
      loginVerifyMethod: getBody.loginVerifyMethod,
      // 라이프사이클 side-column: last_activity_at NOT NULL, 초기 상태에 맞춰 전이시각 세팅 (배치 계산 정합)
      lastActivityAt: new Date(),
      ...(getBody.status === IUserStatus.NOT_USED ? { suspendedAt: new Date() } : {}),
      ...(getBody.status === IUserStatus.LEAVE ? { withdrawnAt: new Date() } : {}),
    });

    // 신규 사용자의 조회 범위 설정 (SUPER_ADMIN만 ALL, 나머지는 SELF)
    const newUserId = insertResult.identifiers[0].id;
    const scopeType = getBody.authority === 'SUPER_ADMIN' ? ViewScopeType.ALL : ViewScopeType.SELF;
    await this.userViewScopeRepository.insert({
      userId: newUserId,
      scopeType: scopeType,
    });

    // 계정 생성 로그 (라이프사이클 — 관리자 경로)
    await this.accountStatusTransitionService.logAccountCreate(newUserId, getBody.email, TransitionSource.ADMIN);

    // 발신번호 SoT 동기화: APPROVED isDefault PHONE 보장 + mirror 갱신(없으면 NULL).
    // user.insert 가 mirror 를 이미 썼지만 seed 가 마지막 권위 write 로 최종값 확정.
    await this.syncFromPhone(newUserId, getBody.fromPhoneNumber);

    // settlement_code 프로비저닝 (추가된 @Transactional 경계 안에서 실행, B3).
    // NEW: company-{id} 코드 + 공유 wallet 생성; SHARE_ONE: 기존 단일 코드 공유(지갑 생성 없음); PENDING: '' 유지.
    if (companyId != null) {
      const classification = await this.settlementCodeAdminService.classifyJoin(companyId, isNewCompany);
      if (classification.mode === 'NEW') {
        await this.settlementCodeAdminService.ensureSettlementCodeWallet(
          companyId,
          classification.code!,
          newCompanyMaximumLimit,
          this.userRepository.manager,
          getBody.settleCondition,
          getBody.settleMethod ?? 'CASH',
        );
        await this.userRepository.update(newUserId, { settlementCode: classification.code });
      } else if (classification.mode === 'SHARE_ONE') {
        await this.userRepository.update(newUserId, { settlementCode: classification.code });
      }
    }

    return;
  }

  @Transactional()
  async update(getBody: UserManagementUpdateReqDto, operator?: ILoginUserInfo) {
    const user = await this.userRepository.findOne({
      where: {
        id: getBody.id,
      },
      relations: ['company'],
    });

    if (!user) {
      throw new BadRequestException('유저가 존재하지 않습니다.');
    }

    // 상태 전이는 공통 헬퍼로 일원화 (side-column + 로그). 직접 세팅 금지 — prevStatus 보관 후 save 뒤 처리.
    const prevStatus = user.status;

    // 사업자등록번호에서 하이픈 제거
    const businessNumber = getBody.businessNumber ? getBody.businessNumber.replace(/-/g, '') : getBody.businessNumber;

    // user_company 업데이트 또는 연결
    // 주의: 최대서비스한도(maximumLimit)는 별도 API(PUT /user-management/maximum-limit)로만 수정 가능
    if (businessNumber) {
      const currentBusinessNumber = user.company?.businessNumber;

      // 사업자등록번호가 변경된 경우
      if (currentBusinessNumber !== businessNumber) {
        // 새로운 사업자등록번호로 기존 회사 검색
        const existingCompany = await this.userCompanyRepository.findOne({
          where: { businessNumber },
        });

        if (existingCompany) {
          // 기존 회사 연결만 — 공유 회사 settleMethod 변경 금지 (타 계정 정산 영향 방지)
          user.companyId = existingCompany.id;
          user.company = existingCompany;
        } else {
          // 새 회사 생성 (최대서비스한도는 기본값 0, 별도 API로 설정)
          const newCompany = await this.userCompanyRepository.save({
            businessNumber: businessNumber,
            businessName: getBody.businessName,
            businessAddress: getBody.businessAddress,
            businessPhoneNumber: getBody.businessPhoneNumber,
            industryType: getBody.industryType,
            industryItem: getBody.industryItem,
            maximumLimit: 0,
            settleMethod: getBody.settleMethod ?? null,
          });
          user.companyId = newCompany.id;
          user.company = newCompany;
        }
      } else if (user.companyId && user.company) {
        // 사업자등록번호가 동일한 경우 기존 회사 정보만 업데이트 (최대서비스한도 제외)
        user.company.businessName = getBody.businessName;
        user.company.businessAddress = getBody.businessAddress;
        user.company.businessPhoneNumber = getBody.businessPhoneNumber;
        user.company.industryType = getBody.industryType;
        user.company.industryItem = getBody.industryItem;
        // settleMethod SoT 동기화 (company.settleMethod 가 정산 계산 소스)
        user.company.settleMethod = getBody.settleMethod ?? null;
        // maximumLimit은 별도 API로만 수정 가능하므로 여기서는 업데이트하지 않음
        await this.userCompanyRepository.save(user.company);
      }
    }

    // user 정보 업데이트 (사업자 관련 필드 제외)
    user.authority = getBody.authority;
    user.personName = getBody.personName;
    user.personPhoneNumber = getBody.personPhoneNumber;
    user.personEmail = getBody.personEmail;
    user.corporateNumber = getBody.corporateNumber;
    user.businessType = getBody.businessType;
    user.ip = getBody.ip;
    user.settleCondition = getBody.settleCondition;
    user.settleMethod = getBody.settleMethod;
    user.bankName = getBody.bankName;
    user.bankNumber = getBody.bankNumber;
    user.cardName = getBody.cardName;
    user.cardNumber = getBody.cardNumber;
    // user.status 는 여기서 직접 세팅하지 않음 — save 후 accountStatusTransitionService 로 일원화 처리.
    // fromPhoneNumber mirror 직접 세팅 제거 — save 이후 seedApprovedDefaultPhone 이 최종 권위 write.

    user.settlePeriodCondition = getBody.settlePeriodCondition;
    user.settlePeriodCount = getBody.settlePeriodCount;
    user.duplicatePhoneLimit = getBody.duplicatePhoneLimit ?? 0;
    // payload 에 없으면(구버전/부분 payload) 셀프서비스 토글 값을 보존한다. 명시 전달 시에만 갱신.
    if (getBody.hideSystemFromPhone !== undefined) {
      user.hideSystemFromPhone = getBody.hideSystemFromPhone;
    }
    user.authorityList = getBody.authorityList.join(',');
    user.allowedSendMethods = getBody.allowedSendMethods.join(',');
    if (getBody.documentCompanyType) {
      user.documentCompanyType = getBody.documentCompanyType;
    }
    if (getBody.loginVerifyMethod) {
      user.loginVerifyMethod = getBody.loginVerifyMethod;
    }

    await this.userRepository.save(user);

    // settleMethod SoT 동기화: wallet_account(WALLET 모드) 또는 company(LEGACY 모드) 에 반영.
    if (getBody.settleMethod !== undefined) {
      const settleMethod = getBody.settleMethod as 'CARD' | 'CASH';
      if (this.walletCutoverConfig.pr3SettleMode === WalletCutoverMode.WALLET) {
        const wallet = await this.walletResolver.resolveByUserId(user.id);
        wallet.settleMethod = settleMethod;
        await this.walletAccountRepository.save(wallet);
      }
    }

    // 발신번호 SoT 동기화: user save 이후 실행해야 mirror 가 stale 로 덮이지 않음.
    // seed 가 APPROVED isDefault 보장 + mirror 최종값 확정(없으면 NULL). 이후 user write 금지.
    if (getBody.fromPhoneNumber !== undefined) {
      await this.syncFromPhone(user.id, getBody.fromPhoneNumber);
    }

    // 상태 변경 시 공통 헬퍼로 전이 (side-column + ACCOUNT_WITHDRAW 로그 등 자동배치와 동일 side-effect 보장)
    if (prevStatus !== getBody.status) {
      await this.accountStatusTransitionService.adminSetStatus(getBody.id, getBody.status);
    }

    // 권한에 따른 user_view_scope 자동 설정 (SUPER_ADMIN만 ALL, 나머지는 SELF)
    const scopeType = getBody.authority === 'SUPER_ADMIN' ? ViewScopeType.ALL : ViewScopeType.SELF;

    const existingViewScope = await this.userViewScopeRepository.findOne({
      where: { userId: getBody.id },
    });

    if (existingViewScope) {
      existingViewScope.scopeType = scopeType;
      await this.userViewScopeRepository.save(existingViewScope);
    } else {
      await this.userViewScopeRepository.insert({
        userId: getBody.id,
        scopeType: scopeType,
      });
    }

    return;
  }

  async passwordReset(getBody: UserManagementPasswordResetReqDto) {
    const { userId } = getBody;
    const user = await this.userRepository.findOne({
      where: {
        id: userId,
      },
    });

    if (!user) {
      throw new BadRequestException('해당 이메일의 유저가 존재하지 않습니다.');
    }
    const tempPassword = generateRandomPassword();
    const loginVerifyMethod = user.loginVerifyMethod ?? LoginVerifyMethod.EMAIL;

    if (loginVerifyMethod === LoginVerifyMethod.PHONE) {
      if (!user.personPhoneNumber) {
        throw new BadRequestException('등록된 연락처가 없습니다. 관리자에게 문의해주세요.');
      }

      const messageText = `임시 비밀번호는 [${tempPassword}] 입니다.`;

      await this.sendViaAlimTalkWithSmsFallback(
        user.personPhoneNumber,
        messageText,
        this.initPasswordTemplateCode,
        user.fromPhoneNumber,
        `비밀번호 초기화 userId=${user.id}`,
      );
    } else {
      const { title, content } = userResetPasswordTemplate(tempPassword);

      await this.mailSendService.send({
        saveSentMail: 'N',
        bcc: undefined,
        cc: undefined,
        content: content,
        subject: title,
        to: user.email,
      });
    }

    const wasLocked = user.isLoginLocked || user.loginFailCount > 0;

    user.password = await this.passwordEncrypt.encrypt(tempPassword);
    user.isPasswordReset = true;
    user.passwordChangedAt = null; // 임시 비밀번호이므로 null로 설정
    user.isLoginLocked = false; // 비밀번호 초기화 시 로그인 잠금 해제
    user.loginFailCount = 0;
    user.lockedAt = null;

    await this.userRepository.save(user);

    // 실제로 잠겨 있었거나 실패 카운트가 있었던 경우만 UNLOCK 로그 (정상 계정 초기화는 노이즈 방지)
    if (wasLocked) {
      await this.activityLogService.createLog({
        userId: user.id,
        userEmail: user.email,
        method: 'POST',
        requestUrl: '/user-management/password-reset',
        actionType: ActivityLogActionType.ACCOUNT_UNLOCK,
        ipAddress: '',
        statusCode: 200,
        result: ActivityLogResult.SUCCESS,
        responseTime: 0,
        requestParams: { method: 'password-reset' },
      });
    }
  }

  /**
   * 로그인 잠금 해제 (관리자). 영구 잠금된 계정을 다시 로그인 가능하게 한다.
   * idempotent: 이미 해제된 계정도 200 no-op 성공. 실제 잠금 상태였을 때만 UNLOCK 로그.
   */
  async unlockLogin(userId: number, admin: ILoginUserInfo) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('해당 유저가 존재하지 않습니다.');
    }

    const wasLocked = user.isLoginLocked || user.loginFailCount > 0;

    if (wasLocked) {
      await this.userRepository.update(user.id, {
        isLoginLocked: false,
        loginFailCount: 0,
        lockedAt: null,
      });

      await this.activityLogService.createLog({
        userId: user.id,
        userEmail: user.email,
        method: 'POST',
        requestUrl: `/user-management/${user.id}/login-unlock`,
        actionType: ActivityLogActionType.ACCOUNT_UNLOCK,
        ipAddress: '',
        statusCode: 200,
        result: ActivityLogResult.SUCCESS,
        responseTime: 0,
        requestParams: { actor: admin?.id, method: 'admin' },
      });
    }
  }

  /**
   * 고객사(회사) 목록 조회 API
   * user_company 테이블 기준으로 중복 없이 고객사 목록을 반환
   */
  async getCompanyList(getQuery: UserManagementGetCompanyListReqQueryDto, loginUser: ILoginUserInfo) {
    const { businessName, page, take } = getQuery;

    let queryBuilder = this.userCompanyRepository.createQueryBuilder('company').where('company.deletedAt IS NULL');

    if (loginUser.authority === IUserAuthority.CORPORATE_ADMIN) {
      const self = await this.userRepository.findOne({
        where: { id: loginUser.id },
        select: ['companyId'],
      });
      queryBuilder = queryBuilder.andWhere('company.id = :companyId', { companyId: self?.companyId ?? -1 });
    }

    if (businessName) {
      queryBuilder = queryBuilder.andWhere('company.businessName LIKE :businessName', {
        businessName: `%${businessName}%`,
      });
    }

    queryBuilder = queryBuilder.orderBy('company.businessName', 'ASC');

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.take(take).skip(skip);

    const [companyList, totalCount] = await queryBuilder.getManyAndCount();

    const resultList = companyList.map((company) => ({
      id: company.id,
      businessName: company.businessName,
      businessNumber: company.businessNumber,
    }));

    const totalPage = Math.ceil(totalCount / take);

    return { list: resultList, totalCount, totalPage, currentPage: page };
  }

  async getMaximumLimitHistory(userId: number): Promise<UserManagementGetMaximumLimitHistoryResDto> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('존재하지 않는 계정입니다.');
    }

    // Activity Log에서 해당 유저의 최대서비스한도 변경 이력 조회
    const logs = await this.activityLogService.getMaximumLimitHistoryByUserId(userId);

    const list: MaximumLimitHistoryItemDto[] = logs.map((log) => ({
      id: log.id,
      createdAt: format(log.createdAt, DateFormatStr),
      beforeMaximumLimit: log.requestParams?.beforeMaximumLimit ?? 0,
      afterMaximumLimit: log.requestParams?.afterMaximumLimit ?? 0,
      operatorEmail: log.userEmail,
      memo: log.requestParams?.memo || null,
    }));

    return { list };
  }

  /**
   * 최대서비스한도(여신한도) 단독 수정 API
   * 팝업에서 바로 적용되는 용도
   */
  @Transactional()
  async modifyMaximumLimit(getBody: UserManagementModifyMaximumLimitReqDto, operator: ILoginUserInfo) {
    const { id, newMaximumLimit, memo } = getBody;

    const user = await this.userRepository.findOne({
      where: { id },
      relations: ['company'],
    });

    if (!user) {
      throw new BadRequestException('존재하지 않는 계정입니다.');
    }

    if (!user.company) {
      throw new BadRequestException('해당 계정에 연결된 회사 정보가 없습니다.');
    }

    // R-modLimit: 회사에 DISTINCT NON-EMPTY settlement_code 가 2개 이상이면 여신 한도는 정산코드별
    // 엔드포인트(PUT /settlement-codes/credit-limit)로만 변경해야 한다. '' (PENDING) 유저는 제외해
    // 실제 코드가 1개뿐인 회사(가입 대기자 혼재)는 그대로 허용한다 (classifyJoin distinct 와 일관).
    const distinctCodeRows = await this.userRepository
      .createQueryBuilder('u')
      .select('DISTINCT u.settlementCode', 'code')
      .where('u.companyId = :companyId', { companyId: user.companyId })
      .andWhere('u.settlementCode IS NOT NULL')
      .andWhere("u.settlementCode != ''")
      .getRawMany<{ code: string | null }>();
    const nonEmptyCodeCount = distinctCodeRows.filter((r) => r.code != null && r.code !== '').length;
    if (nonEmptyCodeCount >= 2) {
      throw new BadRequestException(
        '이 회사는 정산코드가 2개 이상이므로 최대서비스한도(여신한도)는 정산코드별 한도 설정(PUT /settlement-codes/credit-limit)으로 변경해야 합니다.',
      );
    }

    const beforeMaximumLimit = user.company.maximumLimit;

    // 회사의 최대서비스한도 업데이트
    user.company.maximumLimit = newMaximumLimit;
    await this.userCompanyRepository.save(user.company);

    // wallet_account.credit_limit 동기화 (settlement_code 단위).
    // 신규 흐름(WALLET cutover)에서 한도 SoT 는 wallet.creditLimit 이므로,
    // 미동기화 시 maximumLimit 만 바뀌고 주문/잔여한도 조회에는 구한도가 적용된다.
    const wallet = user.settlementCode
      ? await this.walletAccountRepository.findOne({
          where: { ownerType: 'SETTLEMENT_CODE', ownerId: user.settlementCode },
        })
      : null;
    if (wallet) {
      wallet.creditLimit = newMaximumLimit;
      await this.walletAccountRepository.save(wallet);
    } else {
      this.logger.warn(
        `modifyMaximumLimit: credit_limit 미동기화 — userId=${id} settlementCode=${user.settlementCode || '(none)'}`,
      );
    }

    // Activity Log 기록
    await this.activityLogService.createLog({
      userId: operator.id,
      userEmail: operator.email,
      method: 'PUT',
      requestUrl: '/user-management/maximum-limit',
      actionType: ActivityLogActionType.MAXIMUM_LIMIT_MODIFY,
      ipAddress: '',
      statusCode: 200,
      result: ActivityLogResult.SUCCESS,
      responseTime: 0,
      requestParams: {
        targetUserId: id,
        targetUserEmail: user.email,
        targetBusinessName: user.company.businessName ?? '',
        beforeMaximumLimit: beforeMaximumLimit,
        afterMaximumLimit: newMaximumLimit,
        memo: memo || null,
      },
    });
  }

  async changeEmail(getBody: UserManagementChangeEmailReqDto) {
    const { id, newEmail } = getBody;

    const user = await this.userRepository.findOne({
      where: { id },
    });

    if (!user) {
      throw new BadRequestException('유저가 존재하지 않습니다.');
    }

    if (user.email === newEmail) {
      throw new BadRequestException('현재 이메일과 동일합니다.');
    }

    const isExistEmail = await this.userRepository.count({
      where: { email: newEmail },
    });

    if (isExistEmail) {
      throw new BadRequestException('이미 사용 중인 이메일입니다.');
    }

    user.email = newEmail;
    await this.userRepository.save(user);
  }

  // ─── 외부 API 계정: 발급/회수 ────────────────────────────

  /**
   * 외부 API 계정 발급/재발급. user 단위 1:1.
   * 재발급(키회전) 시: SSG/allowedIps/resendMaxCount 보존(A8/S4 — silent 리셋 안 함).
   *           allowedIps는 명시 옵션(resetAllowedIps)일 때만 비움. '리셋' 동작은 별도 reset API(PR2b)로 분리.
   * 어드민 발급일 때만 resendMaxCount 초기 설정 가능.
   */
  @Transactional()
  async generateApiKey(
    userId: number,
    options: GenerateApiKeyReqDto | GenerateApiKeyByAdminReqDto = {},
    isAdmin = false,
  ): Promise<string> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('사용자를 찾을 수 없습니다.');
    }

    const rawKey = randomBytes(32).toString('hex');
    const keyHash = createHash('sha256').update(rawKey).digest('hex');

    const existing = await this.externalApiAccountRepository.findOne({ where: { userId }, withDeleted: true });

    let newAccountId: string | undefined;

    // A8/S4: 재발급=키회전. SSG 게이트 SoT=api_app.ssgEnabled(createSsgOrder)이고 dualWrite 가
    //   app.ssgEnabled 를 회전 시 보존하므로, 재발급 후에도 SSG 가 유지된다(silent 리셋 없음).
    //   account.ssgEnabled 도 동일하게 보존(아래 리셋 미수행)해 account↔app 정합 유지.
    if (existing) {
      existing.apiKeyHash = keyHash;
      existing.isActive = true;

      if (isAdmin && 'resendMaxCount' in options) {
        existing.resendMaxCount = options.resendMaxCount ?? null;
      }
      existing.deletedAt = null;
      await this.externalApiAccountRepository.save(existing);

      if (options.resetAllowedIps) {
        await this.externalApiAllowedIpRepository.delete({ accountId: existing.id });
      }
    } else {
      const account = this.externalApiAccountRepository.create({
        userId,
        apiKeyHash: keyHash,
        isActive: true,
        ssgEnabled: false,
        resendMaxCount: isAdmin && 'resendMaxCount' in options ? (options.resendMaxCount ?? null) : null,
      });
      const savedAccount = await this.externalApiAccountRepository.save(account);
      newAccountId = savedAccount.id;
    }

    // account↔app 결정적 매핑(HIGH-1): dualWrite 가 sourceAccountId 로 app 을 귀속한다.
    const accountId = existing ? existing.id : newAccountId!;

    // PR2a 호환: guard SoT(api_credential→api_app)에 dual-write.
    // 신구 동일 tx(@Transactional). 신규 발급 키가 guard 인증을 통과하도록 보장.
    await this.dualWriteApiAppCredential(userId, accountId, keyHash, isAdmin, options);

    return rawKey;
  }

  @Transactional()
  async revokeApiKey(userId: number): Promise<void> {
    const account = await this.externalApiAccountRepository.findOne({ where: { userId } });

    // PR2a 호환: guard SoT(app/credential) 회수. account↔app 결정적 매핑(sourceAccountId).
    if (account) {
      const app = await this.findAppBySourceAccountId(account.id);
      if (app) {
        await this.deactivateActiveCredentials(app.id, new Date());
        // 단순모드(1 app : 1 active credential): 마지막 credential 회수 시 app 비활성 + soft-delete.
        app.isActive = false;
        await this.apiAppRepository.softRemove(app);
      }
    }

    if (!account) {
      return;
    }
    await this.externalApiAccountRepository.softRemove(account);
    await this.cancelPendingSsgRequests(account.id);
  }

  /**
   * PR2a 호환 dual-write: guard 인증 SoT(api_credential→api_app)를 발급/재발급 시 동기화.
   * - app: sourceAccountId=accountId 기준 결정적 단일 취급(account↔app 1:1). 없으면 생성, 있으면
   *   속성(ssgEnabled/resendMaxCount/webhook/allowedIps) 보존하고 재활성화만(키회전).
   * - credential: 키회전 시 기존 활성 credential 비활성화(is_active=false+revoked_at) 후 신규 행 추가.
   */
  private async dualWriteApiAppCredential(
    userId: number,
    accountId: string,
    keyHash: string,
    isAdmin: boolean,
    options: GenerateApiKeyReqDto | GenerateApiKeyByAdminReqDto,
  ): Promise<void> {
    const now = new Date();

    let app = await this.findAppBySourceAccountId(accountId, { withDeleted: true });

    if (app) {
      // 키회전(재발급): app 속성 보존(S4). 재활성화만.
      app.isActive = true;
      app.deletedAt = null;
      app = await this.apiAppRepository.save(app);
    } else {
      // 신규 발급: account 와 동일 초기값(ssgEnabled=false). sourceAccountId 로 account 결정적 귀속.
      app = this.apiAppRepository.create({
        sourceAccountId: accountId,
        defaultBillingUserId: userId,
        isActive: true,
        ssgEnabled: false,
        resendMaxCount: isAdmin && 'resendMaxCount' in options ? (options.resendMaxCount ?? null) : null,
      });
      app = await this.apiAppRepository.save(app);
    }

    // 키회전: 기존 활성 credential 비활성화 후 신규 credential 추가.
    await this.deactivateActiveCredentials(app.id, now);

    const credential = this.apiCredentialRepository.create({
      apiAppId: app.id,
      apiKeyHash: keyHash,
      isActive: true,
      issuedAt: now,
    });
    await this.apiCredentialRepository.save(credential);
  }

  // ─── 외부 API 계정: 조회/설정 ────────────────────────────

  async getApiKeyInfo(userId: number): Promise<ApiKeyInfoResDto> {
    const account = await this.externalApiAccountRepository.findOne({
      where: { userId },
      relations: ['allowedIps'],
    });

    if (!account) {
      return { exists: false };
    }

    // 매핑 필수 모드는 app 전용 플래그 → app 로드해 노출(app 없으면 false).
    const app = await this.findAppBySourceAccountId(account.id);
    return {
      exists: true,
      requireExternalCustomerId: app?.requireExternalCustomerId ?? false,
      accountId: account.id,
      isActive: account.isActive,
      ssgEnabled: account.ssgEnabled,
      resendMaxCount: account.resendMaxCount,
      allowedIps: (account.allowedIps ?? []).map((ip) => ({
        id: ip.id,
        ip: ip.ipAddress,
        description: ip.description,
      })),
    };
  }

  @Transactional()
  async replaceAllowedIps(accountId: string, dto: UpdateAllowedIpsReqDto): Promise<void> {
    const account = await this.externalApiAccountRepository.findOne({
      where: { id: accountId },
      select: { id: true },
    });
    if (!account) {
      throw new NotFoundException('계정을 찾을 수 없습니다.');
    }
    await this.replaceAllowedIpsForAccount(account.id, dto);
  }

  @Transactional()
  async replaceAllowedIpsByUserId(userId: number, dto: UpdateAllowedIpsReqDto): Promise<void> {
    const account = await this.externalApiAccountRepository.findOne({
      where: { userId },
      select: { id: true },
    });
    if (!account) {
      throw new BadRequestException('API 계정이 발급되어 있지 않습니다.');
    }
    await this.replaceAllowedIpsForAccount(account.id, dto);
  }

  private async replaceAllowedIpsForAccount(accountId: string, dto: UpdateAllowedIpsReqDto): Promise<void> {
    await this.externalApiAllowedIpRepository.delete({ accountId });
    if (dto.ips.length > 0) {
      // app 기준 IP 검사(guard)를 위해 신규 행에 apiAppId 적재. app 미존재 시 null 허용(안전).
      const apiAppId = await this.resolveApiAppIdByAccountId(accountId);
      const rows = dto.ips.map((entry) =>
        this.externalApiAllowedIpRepository.create({
          accountId,
          apiAppId,
          ipAddress: entry.ip,
          description: entry.description ?? null,
        }),
      );
      await this.externalApiAllowedIpRepository.save(rows);
    }
  }

  // accountId → api_app 결정적 해석(account↔app 1:1, sourceAccountId). app 미존재 시 null.
  private async findAppBySourceAccountId(
    accountId: string,
    opts?: { withDeleted?: boolean },
  ): Promise<ApiAppEntity | null> {
    return this.apiAppRepository.findOne({
      where: { sourceAccountId: accountId },
      ...(opts?.withDeleted ? { withDeleted: true } : {}),
    });
  }

  private async resolveApiAppIdByAccountId(accountId: string): Promise<string | null> {
    const app = await this.findAppBySourceAccountId(accountId);
    return app?.id ?? null;
  }

  // app 의 활성 credential 일괄 비활성화(키회전/회수 공통).
  private async deactivateActiveCredentials(appId: string, when: Date): Promise<void> {
    await this.apiCredentialRepository.update(
      { apiAppId: appId, isActive: true },
      { isActive: false, revokedAt: when },
    );
  }

  // 프론트 안정 계약: "API 앱 미프로비저닝" 을 errorCode 로 식별(문구 변경에 안 깨짐).
  // resolveAppOrThrow(매핑/credential 가드)와 설정 토글(app 전용 플래그) 공통 사용.
  private apiAppNotFound(): NotFoundException {
    return new NotFoundException({
      statusCode: 404,
      errorCode: 'API_APP_NOT_FOUND',
      message: 'API 앱을 찾을 수 없습니다.',
    });
  }

  // accountId → api_app 결정적 해석. 없으면 NotFound (credential/매핑 관리 공통 가드).
  // 없으면 apiAppNotFound()(errorCode='API_APP_NOT_FOUND') 로 실패 — "리소스 없음" 404 와 구분.
  private async resolveAppOrThrow(accountId: string): Promise<ApiAppEntity> {
    const app = await this.findAppBySourceAccountId(accountId);
    if (!app) {
      throw this.apiAppNotFound();
    }
    return app;
  }

  // app 에 활성 credential 1건 발급(평문 1회 반환). 발급/회전 공통.
  private async createCredentialForApp(
    appId: string,
    issuedAt: Date = new Date(),
  ): Promise<{ apiKey: string; credentialId: string }> {
    const rawKey = randomBytes(32).toString('hex');
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const credential = this.apiCredentialRepository.create({
      apiAppId: appId,
      apiKeyHash: keyHash,
      isActive: true,
      issuedAt,
    });
    const saved = await this.apiCredentialRepository.save(credential);
    return { apiKey: rawKey, credentialId: saved.id };
  }

  // ─── 다중키/회전 credential 관리 (PR2 Phase 6) ───────────
  // accountId(=external_api_account.id) → api_app(sourceAccountId) 해석 후 credential 발급/조회/회수.
  // guard 는 credential.apiKeyHash(활성) 단건 조회라 한 app 에 복수 활성 credential 이 동시 인증 가능.

  // 추가 credential 발급(기존 활성키 유지 = 다중키). 평문 1회 반환.
  @Transactional()
  async issueCredential(accountId: string): Promise<{ apiKey: string; credentialId: string }> {
    const app = await this.resolveAppOrThrow(accountId);
    return this.createCredentialForApp(app.id);
  }

  // app 의 credential 목록(메타, raw key 미노출).
  async listCredentials(
    accountId: string,
  ): Promise<Array<{ id: string; isActive: boolean; issuedAt: Date; revokedAt: Date | null }>> {
    const app = await this.resolveAppOrThrow(accountId);
    const credentials = await this.apiCredentialRepository.find({
      where: { apiAppId: app.id },
      order: { issuedAt: 'DESC' },
    });
    return credentials.map((c) => ({
      id: c.id,
      isActive: c.isActive,
      issuedAt: c.issuedAt,
      revokedAt: c.revokedAt,
    }));
  }

  // 특정 credential 회수(다중키 중 하나). 이미 회수면 멱등 no-op.
  @Transactional()
  async revokeCredential(accountId: string, credentialId: string): Promise<void> {
    const app = await this.resolveAppOrThrow(accountId);
    const credential = await this.apiCredentialRepository.findOne({
      where: { id: credentialId, apiAppId: app.id },
    });
    if (!credential) {
      throw new NotFoundException('자격증명을 찾을 수 없습니다.');
    }
    if (!credential.isActive) {
      return;
    }
    credential.isActive = false;
    credential.revokedAt = new Date();
    await this.apiCredentialRepository.save(credential);
  }

  // 회전: 기존 활성 credential 전부 회수 + 신규 1건 발급. 평문 1회 반환.
  @Transactional()
  async rotateCredential(accountId: string): Promise<{ apiKey: string; credentialId: string }> {
    const app = await this.resolveAppOrThrow(accountId);
    const now = new Date();
    await this.deactivateActiveCredentials(app.id, now);
    return this.createCredentialForApp(app.id, now);
  }

  // ─── 3계층 매핑모드 고객 매핑 CRUD (PR2 Phase 7) ──────────
  // accountId → api_app(sourceAccountId) 해석 후 (apiAppId, externalCustomerId)→billingUserId 매핑 관리.
  // active-only unique(generated active_key)로 활성 중복 차단, soft-delete 후 재등록 허용.

  @Transactional()
  async createCustomerMapping(accountId: string, dto: CreateCustomerMappingReqDto): Promise<CustomerMappingResDto> {
    const app = await this.resolveAppOrThrow(accountId);
    await this.assertBillingUserAllowed(dto.billingUserId);
    const externalCustomerId = dto.externalCustomerId.trim();
    // active 중복(soft-delete 제외) 사전 검사 → 409. DB active_key unique 가 동시성 최종 방어선.
    const existing = await this.apiCustomerMappingRepository.findOne({
      where: { apiAppId: app.id, externalCustomerId },
    });
    if (existing) {
      throw new ConflictException('이미 등록된 externalCustomerId 입니다.');
    }
    const mapping = this.apiCustomerMappingRepository.create({
      apiAppId: app.id,
      externalCustomerId,
      billingUserId: dto.billingUserId,
    });
    let saved: ApiCustomerMappingEntity;
    try {
      saved = await this.apiCustomerMappingRepository.save(mapping);
    } catch (e) {
      if ((e as { code?: string })?.code === 'ER_DUP_ENTRY') {
        throw new ConflictException('이미 등록된 externalCustomerId 입니다.');
      }
      throw e;
    }
    return this.toMappingRes(saved);
  }

  async listCustomerMappings(accountId: string): Promise<CustomerMappingResDto[]> {
    const app = await this.resolveAppOrThrow(accountId);
    const mappings = await this.apiCustomerMappingRepository.find({
      where: { apiAppId: app.id },
      order: { id: 'DESC' },
    });
    return mappings.map((m) => this.toMappingRes(m));
  }

  @Transactional()
  async updateCustomerMapping(
    accountId: string,
    mappingId: string,
    dto: UpdateCustomerMappingReqDto,
  ): Promise<CustomerMappingResDto> {
    const app = await this.resolveAppOrThrow(accountId);
    await this.assertBillingUserAllowed(dto.billingUserId);
    const mapping = await this.apiCustomerMappingRepository.findOne({
      where: { id: mappingId, apiAppId: app.id },
    });
    if (!mapping) {
      throw new NotFoundException('매핑을 찾을 수 없습니다.');
    }
    mapping.billingUserId = dto.billingUserId;
    const saved = await this.apiCustomerMappingRepository.save(mapping);
    return this.toMappingRes(saved);
  }

  @Transactional()
  async deleteCustomerMapping(accountId: string, mappingId: string): Promise<void> {
    const app = await this.resolveAppOrThrow(accountId);
    const mapping = await this.apiCustomerMappingRepository.findOne({
      where: { id: mappingId, apiAppId: app.id },
    });
    if (!mapping) {
      throw new NotFoundException('매핑을 찾을 수 없습니다.');
    }
    await this.apiCustomerMappingRepository.softRemove(mapping);
  }

  // billing user 정책범위 검증(PR2 확정 정책):
  //   SUPER/OPERATION 어드민이 **활성(존재 + NOT_USED/LEAVE 아님)** billing user 를 매핑할 수 있다.
  //   **회사(company)/계정 범위 제한은 의도적으로 두지 않는다** — 3계층 매핑모드의 목적이 한 호출주체(api_app)가
  //   서로 다른 회사의 광고주(예: WiseAd 하위 광고주)를 각자 premium 계정에 귀속시키는 것이라, 같은 회사로
  //   제한하면 핵심 use case 가 깨진다. 따라서 권한 통제는 어드민 가드(SUPER/OPERATION)로, 정합성은 활성상태
  //   fail-closed 로 보장한다(runtime resolver loadActiveBillingUser 와 동일 기준).
  private async assertBillingUserAllowed(billingUserId: number): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id: billingUserId } });
    if (!user) {
      throw new BadRequestException('billing user 를 찾을 수 없습니다.');
    }
    if (user.status === IUserStatus.NOT_USED || user.status === IUserStatus.LEAVE) {
      throw new BadRequestException('비활성 billing user 는 매핑할 수 없습니다.');
    }
  }

  private toMappingRes(m: ApiCustomerMappingEntity): CustomerMappingResDto {
    return {
      id: m.id,
      apiAppId: m.apiAppId,
      externalCustomerId: m.externalCustomerId,
      billingUserId: m.billingUserId,
    };
  }
  @Transactional()
  async addAllowedIp(accountId: string, dto: AddAllowedIpReqDto): Promise<{ id: string }> {
    const account = await this.externalApiAccountRepository.findOne({
      where: { id: accountId },
      select: { id: true },
    });
    if (!account) {
      throw new NotFoundException('계정을 찾을 수 없습니다.');
    }
    return this.addAllowedIpForAccount(account.id, dto);
  }

  @Transactional()
  async addAllowedIpByUserId(userId: number, dto: AddAllowedIpReqDto): Promise<{ id: string }> {
    const account = await this.externalApiAccountRepository.findOne({
      where: { userId },
      select: { id: true },
    });
    if (!account) {
      throw new BadRequestException('API 계정이 발급되어 있지 않습니다.');
    }
    return this.addAllowedIpForAccount(account.id, dto);
  }

  private async addAllowedIpForAccount(accountId: string, dto: AddAllowedIpReqDto): Promise<{ id: string }> {
    const count = await this.externalApiAllowedIpRepository.count({ where: { accountId } });
    if (count >= 50) {
      throw new BadRequestException('허용 IP는 최대 50개까지 등록할 수 있습니다.');
    }
    const exists = await this.externalApiAllowedIpRepository.findOne({
      where: { accountId, ipAddress: dto.ip },
      select: { id: true },
    });
    if (exists) {
      throw new ConflictException('이미 등록된 IP입니다.');
    }
    const apiAppId = await this.resolveApiAppIdByAccountId(accountId);
    const entity = this.externalApiAllowedIpRepository.create({
      accountId,
      apiAppId,
      ipAddress: dto.ip,
      description: dto.description ?? null,
    });
    const saved = await this.externalApiAllowedIpRepository.save(entity);
    return { id: saved.id };
  }

  @Transactional()
  async deleteAllowedIp(accountId: string, ipId: string): Promise<void> {
    const account = await this.externalApiAccountRepository.findOne({
      where: { id: accountId },
      select: { id: true },
    });
    if (!account) {
      throw new NotFoundException('계정을 찾을 수 없습니다.');
    }
    await this.deleteAllowedIpForAccount(account.id, ipId);
  }

  @Transactional()
  async deleteAllowedIpByUserId(userId: number, ipId: string): Promise<void> {
    const account = await this.externalApiAccountRepository.findOne({
      where: { userId },
      select: { id: true },
    });
    if (!account) {
      throw new BadRequestException('API 계정이 발급되어 있지 않습니다.');
    }
    await this.deleteAllowedIpForAccount(account.id, ipId);
  }

  private async deleteAllowedIpForAccount(accountId: string, ipId: string): Promise<void> {
    const result = await this.externalApiAllowedIpRepository.delete({
      id: ipId,
      accountId,
    });
    if (!result.affected) {
      throw new NotFoundException('해당 IP를 찾을 수 없습니다.');
    }
  }

  /**
   * 어드민 전용 설정 토글.
   * ssgEnabled=true 직접 세팅도 허용하나, 권장 흐름은 SSG 요청 승인.
   */
  @Transactional()
  async updateApiKeySettings(accountId: string, dto: UpdateApiKeySettingsReqDto): Promise<void> {
    const account = await this.externalApiAccountRepository.findOne({ where: { id: accountId } });
    if (!account) {
      throw new NotFoundException('계정을 찾을 수 없습니다.');
    }

    if (dto.isActive !== undefined) account.isActive = dto.isActive;
    if (dto.ssgEnabled !== undefined) account.ssgEnabled = dto.ssgEnabled;
    if (dto.resendMaxCount !== undefined) account.resendMaxCount = dto.resendMaxCount;

    await this.externalApiAccountRepository.save(account);

    // PR2a 호환: api_app(guard SoT)에도 설정 미러링해 account 와 싱크 유지.
    const app = await this.findAppBySourceAccountId(account.id);
    // requireExternalCustomerId 는 app 전용 플래그 → app 없이 전달되면 조용히 삼키지 않고 실패시킨다.
    if (dto.requireExternalCustomerId !== undefined && !app) {
      throw this.apiAppNotFound();
    }
    if (app) {
      if (dto.isActive !== undefined) app.isActive = dto.isActive;
      if (dto.ssgEnabled !== undefined) app.ssgEnabled = dto.ssgEnabled;
      if (dto.resendMaxCount !== undefined) app.resendMaxCount = dto.resendMaxCount;
      if (dto.requireExternalCustomerId !== undefined) app.requireExternalCustomerId = dto.requireExternalCustomerId;
      await this.apiAppRepository.save(app);
    }
  }

  // ─── 외부 API: SSG 활성화 요청 ──────────────────────────

  async createSsgRequest(userId: number, reason: string): Promise<SsgRequestResDto> {
    const account = await this.externalApiAccountRepository.findOne({ where: { userId } });
    if (!account) {
      throw new BadRequestException('API 계정이 발급되어 있지 않습니다.');
    }
    if (account.ssgEnabled) {
      throw new BadRequestException('이미 SSG가 활성화되어 있습니다.');
    }

    const pending = await this.externalApiSsgRequestRepository.findOne({
      where: { accountId: account.id, status: IExternalApiSsgRequestStatus.PENDING },
    });
    if (pending) {
      throw new BadRequestException('이미 처리 대기 중인 요청이 있습니다.');
    }

    const created = this.externalApiSsgRequestRepository.create({
      accountId: account.id,
      requestedByUserId: userId,
      reason,
      status: IExternalApiSsgRequestStatus.PENDING,
    });
    const saved = await this.externalApiSsgRequestRepository.save(created);
    return this.toSsgRequestDto(saved);
  }

  async cancelSsgRequest(userId: number, requestId: string): Promise<void> {
    const request = await this.externalApiSsgRequestRepository.findOne({ where: { id: requestId } });
    if (!request) {
      throw new NotFoundException('요청을 찾을 수 없습니다.');
    }
    if (request.requestedByUserId !== userId) {
      throw new ForbiddenException('본인 요청만 취소할 수 있습니다.');
    }
    if (request.status !== IExternalApiSsgRequestStatus.PENDING) {
      throw new BadRequestException('PENDING 상태만 취소할 수 있습니다.');
    }
    request.status = IExternalApiSsgRequestStatus.CANCELLED;
    await this.externalApiSsgRequestRepository.save(request);
  }

  async getMySsgRequests(userId: number): Promise<SsgRequestResDto[]> {
    const account = await this.externalApiAccountRepository.findOne({ where: { userId } });
    if (!account) {
      return [];
    }
    const list = await this.externalApiSsgRequestRepository.find({
      where: { accountId: account.id },
      relations: ['requestedByUser', 'decidedByUser'],
      order: { createdAt: 'DESC' },
    });
    return list.map((r) => this.toSsgRequestDto(r));
  }

  async listSsgRequests(filters: {
    status?: IExternalApiSsgRequestStatus;
    accountId?: string;
  }): Promise<SsgRequestResDto[]> {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.accountId) where.accountId = filters.accountId;

    const list = await this.externalApiSsgRequestRepository.find({
      where,
      relations: ['requestedByUser', 'decidedByUser'],
      order: { createdAt: 'DESC' },
    });
    return list.map((r) => this.toSsgRequestDto(r));
  }

  @Transactional()
  async approveSsgRequest(requestId: string, decidedByUserId: number, note?: string): Promise<SsgRequestResDto> {
    const request = await this.externalApiSsgRequestRepository.findOne({
      where: { id: requestId },
      relations: ['requestedByUser'],
    });
    if (!request) {
      throw new NotFoundException('요청을 찾을 수 없습니다.');
    }
    if (request.status !== IExternalApiSsgRequestStatus.PENDING) {
      throw new BadRequestException('PENDING 상태만 처리할 수 있습니다.');
    }

    const account = await this.externalApiAccountRepository.findOne({ where: { id: request.accountId } });
    if (!account) {
      throw new NotFoundException('대상 계정을 찾을 수 없습니다.');
    }

    request.status = IExternalApiSsgRequestStatus.APPROVED;
    request.decidedByUserId = decidedByUserId;
    request.decidedAt = new Date();
    request.decisionNote = note ?? null;
    await this.externalApiSsgRequestRepository.save(request);

    account.ssgEnabled = true;
    await this.externalApiAccountRepository.save(account);

    // SSG 게이트 SoT = api_app.ssgEnabled (createSsgOrder) → 승인도 app 에 미러(미러 누락 시 승인계정 1005).
    const app = await this.findAppBySourceAccountId(account.id);
    if (app) {
      app.ssgEnabled = true;
      await this.apiAppRepository.save(app);
    }

    const decidedByUser = await this.userRepository.findOne({ where: { id: decidedByUserId } });
    request.decidedByUser = decidedByUser ?? null;
    return this.toSsgRequestDto(request);
  }

  @Transactional()
  async rejectSsgRequest(requestId: string, decidedByUserId: number, note?: string): Promise<SsgRequestResDto> {
    const request = await this.externalApiSsgRequestRepository.findOne({
      where: { id: requestId },
      relations: ['requestedByUser'],
    });
    if (!request) {
      throw new NotFoundException('요청을 찾을 수 없습니다.');
    }
    if (request.status !== IExternalApiSsgRequestStatus.PENDING) {
      throw new BadRequestException('PENDING 상태만 처리할 수 있습니다.');
    }

    request.status = IExternalApiSsgRequestStatus.REJECTED;
    request.decidedByUserId = decidedByUserId;
    request.decidedAt = new Date();
    request.decisionNote = note ?? null;
    await this.externalApiSsgRequestRepository.save(request);

    const decidedByUser = await this.userRepository.findOne({ where: { id: decidedByUserId } });
    request.decidedByUser = decidedByUser ?? null;
    return this.toSsgRequestDto(request);
  }

  // ─── 헬퍼 ──────────────────────────────────────────────

  private async cancelPendingSsgRequests(accountId: string): Promise<void> {
    await this.externalApiSsgRequestRepository.update(
      { accountId, status: IExternalApiSsgRequestStatus.PENDING },
      { status: IExternalApiSsgRequestStatus.CANCELLED },
    );
  }

  private toSsgRequestDto(request: ExternalApiSsgRequestEntity): SsgRequestResDto {
    return {
      id: request.id,
      accountId: request.accountId,
      requestedByUserId: request.requestedByUserId,
      requestedByUserName: request.requestedByUser?.personName,
      reason: request.reason,
      status: request.status,
      decidedByUserId: request.decidedByUserId,
      decidedByUserName: request.decidedByUser?.personName ?? null,
      decidedAt: request.decidedAt,
      decisionNote: request.decisionNote,
      createdAt: request.createdAt,
    };
  }
}
