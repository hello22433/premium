import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { UserEntity } from '../../entity/user.entity';
import { IUserStatus } from '../../user/interface/user.status';
import { UserCompanyEntity } from '../../entity/user.company.entity';
import { UserViewScopeEntity, ViewScopeType } from '../../entity/user.view.scope.entity';
import { DepartmentEntity } from '../../entity/department.entity';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
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
import { ActivityLogEntity } from '../../entity/activity.log.entity';
import { format } from 'date-fns';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { CompanyType } from '../../common/domain/company.type';

@Injectable()
export class UserManagementService {
  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(UserCompanyEntity)
    private userCompanyRepository: Repository<UserCompanyEntity>,
    @InjectRepository(UserViewScopeEntity)
    private userViewScopeRepository: Repository<UserViewScopeEntity>,
    @InjectRepository(DepartmentEntity)
    private departmentRepository: Repository<DepartmentEntity>,
    private passwordEncrypt: PasswordBcryptEncrypt,
    @Inject('IMailSend')
    private readonly mailSendService: IMailSend,
    private activityLogService: ActivityLogService,
  ) { }

  /**
   * 회사 레벨 선충전 관리 모드인지 확인
   */
  private isCompanyBalanceMode(company: UserCompanyEntity | null): company is UserCompanyEntity {
    return company?.balanceManagementType === 'COMPANY';
  }

  async getNameList(getQuery: UserManagementGetNameListReqQueryDto): Promise<UserManagementGetNameListResDto> {
    const { authority } = getQuery;

    let queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.company', 'company')
      .where('user.status = :activeStatus', { activeStatus: IUserStatus.USED });

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

    let queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.company', 'company');

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

    return {
      id: user.id,
      email: user.email,
      isPasswordReset: user.isPasswordReset,
      authority: user.authority,
      status: user.status,
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
      fromPhoneNumber: user.fromPhoneNumber,

      settlePeriodCondition: user.settlePeriodCondition,
      settlePeriodCount: user.settlePeriodCount,
      duplicatePhoneLimit: user.duplicatePhoneLimit,
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
      allowedSendMethods: user.allowedSendMethods ? user.allowedSendMethods.split(',').map(m => m === 'SMS' ? 'MMS' : m) : ['ALIM_TALK', 'MMS', 'EMAIL'],
      loginVerifyMethod: user.loginVerifyMethod,
    };
  }

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

    await this.activityLogService.createLog({
      userId: operator.id,
      userEmail: operator.email,
      method: 'PUT',
      requestUrl: '/user-management/balance',
      actionType: ActivityLogActionType.BALANCE_CHARGE,
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
        chargeAmount: chargeAmount,
        beforeBalance: beforeBalance,
        afterBalance: afterBalance,
        memo: memo || null,
      },
    });
  }

  /**
   * 잔액 업데이트 공통 로직 (회사/계정 레벨 분기 처리)
   */
  private async updateBalance(
    user: UserEntity,
    company: UserCompanyEntity | null,
    amount: number,
  ): Promise<{ beforeBalance: number; afterBalance: number }> {
    if (this.isCompanyBalanceMode(company)) {
      const beforeBalance = company.balance;
      company.balance += amount;
      await this.userCompanyRepository.save(company);
      return { beforeBalance, afterBalance: company.balance };
    }

    const beforeBalance = user.balance;
    user.balance += amount;
    await this.userRepository.save(user);
    return { beforeBalance, afterBalance: user.balance };
  }

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

    await this.activityLogService.createLog({
      userId: operator.id,
      userEmail: operator.email,
      method: 'PUT',
      requestUrl: '/user-management/balance/modify',
      actionType: ActivityLogActionType.BALANCE_MODIFY,
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
        changeAmount: changeAmount,
        beforeBalance: beforeBalance,
        afterBalance: newBalance,
        memo: memo || null,
      },
    });
  }

  /**
   * 잔액을 특정 값으로 설정하는 공통 로직 (회사/계정 레벨 분기 처리)
   */
  private async setBalance(
    user: UserEntity,
    company: UserCompanyEntity | null,
    newBalance: number,
  ): Promise<{ beforeBalance: number }> {
    if (this.isCompanyBalanceMode(company)) {
      const beforeBalance = company.balance;
      company.balance = newBalance;
      await this.userCompanyRepository.save(company);
      return { beforeBalance };
    }

    const beforeBalance = user.balance;
    user.balance = newBalance;
    await this.userRepository.save(user);
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
      amount: log.requestParams?.chargeAmount ?? log.requestParams?.changeAmount ?? 0,
      beforeBalance: log.requestParams?.beforeBalance ?? 0,
      afterBalance: log.requestParams?.afterBalance ?? 0,
      operatorEmail: log.userEmail,
      memo: log.requestParams?.memo || null,
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

  async deductBalance(id: number, amount: number): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id },
      relations: ['company'],
    });
    if (!user) {
      throw new BadRequestException('존재하지 않는 계정입니다.');
    }

    const currentBalance = this.getCurrentBalance(user, user.company);
    if (currentBalance < amount) {
      throw new BadRequestException('잔액이 부족합니다.');
    }

    await this.updateBalance(user, user.company, -amount);
  }

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
        beforeBalance: beforeBalance,
        afterBalance: afterBalance,
        memo: memo || '시스템 자동 환불',
      },
    });
  }

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
    if (businessNumber) {
      let existingCompany = await this.userCompanyRepository.findOne({
        where: { businessNumber },
      });

      if (existingCompany) {
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
        });
        companyId = newCompany.id;
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
      authorityList: getBody.authorityList.join(','),
      companyId: companyId,
      allowedSendMethods: getBody.allowedSendMethods.join(','),
      documentCompanyType: getBody.documentCompanyType ?? CompanyType.ENMAD,
      loginVerifyMethod: getBody.loginVerifyMethod,
    });

    // 신규 사용자의 조회 범위 설정 (SUPER_ADMIN만 ALL, 나머지는 SELF)
    const newUserId = insertResult.identifiers[0].id;
    const scopeType =
      getBody.authority === 'SUPER_ADMIN'
        ? ViewScopeType.ALL
        : ViewScopeType.SELF;
    await this.userViewScopeRepository.insert({
      userId: newUserId,
      scopeType: scopeType,
    });

    return;
  }

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
          // 이미 존재하는 회사로 연결
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
    user.status = getBody.status;
    user.fromPhoneNumber = getBody.fromPhoneNumber;

    user.settlePeriodCondition = getBody.settlePeriodCondition;
    user.settlePeriodCount = getBody.settlePeriodCount;
    user.duplicatePhoneLimit = getBody.duplicatePhoneLimit ?? 0;
    user.authorityList = getBody.authorityList.join(',');
    user.allowedSendMethods = getBody.allowedSendMethods.join(',');
    if (getBody.documentCompanyType) {
      user.documentCompanyType = getBody.documentCompanyType;
    }
    if (getBody.loginVerifyMethod) {
      user.loginVerifyMethod = getBody.loginVerifyMethod;
    }

    await this.userRepository.save(user);

    // 권한에 따른 user_view_scope 자동 설정 (SUPER_ADMIN만 ALL, 나머지는 SELF)
    const scopeType =
      getBody.authority === 'SUPER_ADMIN'
        ? ViewScopeType.ALL
        : ViewScopeType.SELF;

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

    const { title, content } = userResetPasswordTemplate(tempPassword);

    await this.mailSendService.send({
      saveSentMail: 'N',
      bcc: undefined,
      cc: undefined,
      content: content,
      subject: title,
      to: user.email,
    });

    user.password = await this.passwordEncrypt.encrypt(tempPassword);
    user.isPasswordReset = true;
    user.passwordChangedAt = null; // 임시 비밀번호이므로 null로 설정

    await this.userRepository.save(user);

    return;
  }

  /**
   * 고객사(회사) 목록 조회 API
   * user_company 테이블 기준으로 중복 없이 고객사 목록을 반환
   */
  async getCompanyList(getQuery: UserManagementGetCompanyListReqQueryDto) {
    const { businessName, page, take } = getQuery;

    let queryBuilder = this.userCompanyRepository
      .createQueryBuilder('company')
      .where('company.deletedAt IS NULL');

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

    const beforeMaximumLimit = user.company.maximumLimit;

    // 회사의 최대서비스한도 업데이트
    user.company.maximumLimit = newMaximumLimit;
    await this.userCompanyRepository.save(user.company);

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
}
