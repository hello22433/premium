import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { UserEntity } from '../../entity/user.entity';
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
} from '../api/user.management.req.dto';
import {
  UserManagementGetDetailResDto,
  UserManagementGetListResDto,
  UserManagementGetNameListResDto,
  UserManagementGetBalanceHistoryResDto,
  BalanceHistoryItemDto,
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
  ) {}

  async getNameList(getQuery: UserManagementGetNameListReqQueryDto): Promise<UserManagementGetNameListResDto> {
    const { authority } = getQuery;

    let queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.company', 'company');

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

    if (createdStartAt && !createdEndAt) {
      queryBuilder = queryBuilder.andWhere('user.createdAt >= :createdStartAt', {
        createdStartAt: new Date(createdStartAt),
      });
    }

    if (!createdStartAt && createdEndAt) {
      queryBuilder = queryBuilder.andWhere('user.createdAt <= :createdEndAt', {
        createdEndAt: new Date(createdEndAt),
      });
    }

    if (createdStartAt && createdEndAt) {
      queryBuilder = queryBuilder.andWhere('user.createdAt BETWEEN :createdStartAt AND :createdEndAt', {
        createdStartAt: new Date(createdStartAt),
        createdEndAt: new Date(createdEndAt),
      });
    }

    if (email) {
      queryBuilder = queryBuilder.andWhere('user.email LIKE :email', { email: `${email}%` });
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
        balance: user.balance,
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
      balance: user.balance,
      fromPhoneNumber: user.fromPhoneNumber,

      settlePeriodCondition: user.settlePeriodCondition,
      settlePeriodCount: user.settlePeriodCount,
      duplicatePhoneLimit: user.duplicatePhoneLimit,
      authorityList: authorityList,
      industryType: company?.industryType ?? null,
      industryItem: company?.industryItem ?? null,
      companyId: user.companyId,
      company: company
        ? {
            id: company.id,
            businessName: company.businessName,
            businessNumber: company.businessNumber,
            maximumLimit: company.maximumLimit,
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
    };
  }

  async chargeBalance(getBody: UserManagementChargeBalanceReqDto, operator: ILoginUserInfo) {
    const { id, chargeAmount } = getBody;

    const user = await this.userRepository.findOne({
      where: {
        id,
      },
      relations: ['company'],
    });

    if (!user) {
      throw new BadRequestException('not found user');
    }

    const beforeBalance = user.balance;
    user.balance += chargeAmount;
    const afterBalance = user.balance;

    await this.userRepository.save(user);

    // Activity Log 기록
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
        targetBusinessName: user.company?.businessName ?? '',
        chargeAmount: chargeAmount,
        beforeBalance: beforeBalance,
        afterBalance: afterBalance,
      },
    });
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

    const beforeBalance = user.balance;
    const changeAmount = newBalance - beforeBalance;

    user.balance = newBalance;

    await this.userRepository.save(user);

    // Activity Log 기록
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
        targetBusinessName: user.company?.businessName ?? '',
        changeAmount: changeAmount,
        beforeBalance: beforeBalance,
        afterBalance: newBalance,
        memo: memo || null,
      },
    });
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
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new BadRequestException('존재하지 않는 계정입니다.');
    }
    return user.balance;
  }

  async deductBalance(id: number, amount: number): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new BadRequestException('존재하지 않는 계정입니다.');
    }
    if (user.balance < amount) {
      throw new BadRequestException('잔액이 부족합니다.');
    }
    user.balance -= amount;
    await this.userRepository.save(user);
  }

  async addBalance(id: number, amount: number): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new BadRequestException('존재하지 않는 계정입니다.');
    }
    user.balance += amount;
    await this.userRepository.save(user);
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
    });

    // 신규 사용자의 조회 범위 설정 (SUPER_ADMIN은 ALL, 나머지는 SELF)
    const newUserId = insertResult.identifiers[0].id;
    const scopeType = getBody.authority === 'SUPER_ADMIN' ? ViewScopeType.ALL : ViewScopeType.SELF;
    await this.userViewScopeRepository.insert({
      userId: newUserId,
      scopeType: scopeType,
    });

    return;
  }

  async update(getBody: UserManagementUpdateReqDto) {
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

    // user_company 업데이트 또는 생성
    if (user.companyId && user.company) {
      // 기존 회사 정보 업데이트
      user.company.businessNumber = businessNumber;
      user.company.businessName = getBody.businessName;
      user.company.businessAddress = getBody.businessAddress;
      user.company.businessPhoneNumber = getBody.businessPhoneNumber;
      user.company.industryType = getBody.industryType;
      user.company.industryItem = getBody.industryItem;
      user.company.maximumLimit = getBody.maximumLimit;
      await this.userCompanyRepository.save(user.company);
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

    await this.userRepository.save(user);

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
}
