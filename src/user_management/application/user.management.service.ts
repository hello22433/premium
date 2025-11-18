import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { UserEntity } from '../../entity/user.entity';
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
} from '../api/user.management.req.dto';
import {
  UserManagementGetDetailResDto,
  UserManagementGetListResDto,
  UserManagementGetNameListResDto,
} from '../api/user.management.res.dto';
import { UserManagementViewDto } from '../api/dto/user.management.view.dto';
import { PasswordBcryptEncrypt } from '../../auth/infrastructure/password.bcrypt.encrypt';
import { UserManagementNameViewDto } from '../api/dto/user.management.name.view.dto';
import { generateRandomPassword } from '../../user_find/domain/user.password.regex';
import { userResetPasswordTemplate } from '../../user_find/domain/user.reset.password.template.html';
import { IMailSend } from '../../mail/interface/mail-send';
import { UserSettlePeriodConditionEnum } from '../../user/interface/user.settle.period.condition.enum';
import { IUserSettleCondition } from '../../user/interface/user.settle.condition';

@Injectable()
export class UserManagementService {
  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private passwordEncrypt: PasswordBcryptEncrypt,
    @Inject('IMailSend')
    private readonly mailSendService: IMailSend,
  ) {}

  async getNameList(getQuery: UserManagementGetNameListReqQueryDto): Promise<UserManagementGetNameListResDto> {
    const { authority } = getQuery;

    let queryBuilder = this.userRepository.createQueryBuilder('user');

    if (authority) {
      queryBuilder = queryBuilder.andWhere('user.authority = :authority', { authority });
    }

    const userList = await queryBuilder.getMany();
    const resultList: UserManagementNameViewDto[] = userList.map((user) => {
      return {
        id: user.id,
        businessName: user.businessName,
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

    let queryBuilder = this.userRepository.createQueryBuilder('user');

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
      queryBuilder = queryBuilder.andWhere('user.businessName LIKE :businessName', {
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
        businessName: user.businessName,
        personName: user.personName,
        personPhoneNumber: user.personPhoneNumber,
        settleCondition: user.settleCondition,
        settleMethod: user.settleMethod,
        maximumLimit: user.maximumLimit,
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
    });

    if (!user) {
      throw new BadRequestException('유저가 존재하지 않습니다.');
    }

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
      businessNumber: user.businessNumber,
      businessName: user.businessName,
      businessAddress: user.businessAddress,
      businessPhoneNumber: user.businessPhoneNumber,
      ip: user.ip,
      settleCondition: user.settleCondition,
      settleMethod: user.settleMethod,
      maximumLimit: user.maximumLimit,

      bankName: user.bankName,
      bankNumber: user.bankNumber,
      cardName: user.cardName,
      cardNumber: user.cardNumber,
      balance: user.balance,
      fromPhoneNumber: user.fromPhoneNumber,

      settlePeriodCondition: user.settlePeriodCondition,
      settlePeriodCount: user.settlePeriodCount,
      duplicatePhoneLimit: user.duplicatePhoneLimit,
    };
  }

  async chargeBalance(getBody: UserManagementChargeBalanceReqDto) {
    const { id, chargeAmount } = getBody;

    const user = await this.userRepository.findOne({
      where: {
        id,
      },
    });

    if (!user) {
      throw new BadRequestException('not found user');
    }

    user.balance += chargeAmount;

    // 선정산 계정의 경우 최대서비스한도도 증가
    if (user.settleCondition === IUserSettleCondition.PRE_PAYMENT) {
      user.maximumLimit += chargeAmount;
    }

    await this.userRepository.save(user);
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

    await this.userRepository.insert({
      email: getBody.email,
      password: passwordEncrypt,
      authority: getBody.authority,
      personName: getBody.personName,
      personPhoneNumber: getBody.personPhoneNumber,
      personEmail: getBody.personEmail,
      corporateNumber: getBody.corporateNumber,
      businessType: getBody.businessType,
      businessNumber: businessNumber,
      businessName: getBody.businessName,
      businessAddress: getBody.businessAddress,
      businessPhoneNumber: getBody.businessPhoneNumber,
      ip: getBody.ip,
      settleCondition: getBody.settleCondition,
      settleMethod: getBody.settleMethod,
      maximumLimit: getBody.maximumLimit,
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
    });

    return;
  }

  async update(getBody: UserManagementUpdateReqDto) {
    const user = await this.userRepository.findOne({
      where: {
        id: getBody.id,
      },
    });

    if (!user) {
      throw new BadRequestException('유저가 존재하지 않습니다.');
    }

    // 사업자등록번호에서 하이픈 제거
    const businessNumber = getBody.businessNumber ? getBody.businessNumber.replace(/-/g, '') : getBody.businessNumber;

    user.authority = getBody.authority;
    user.personName = getBody.personName;
    user.personPhoneNumber = getBody.personPhoneNumber;
    user.personEmail = getBody.personEmail;
    user.corporateNumber = getBody.corporateNumber;
    user.businessType = getBody.businessType;
    user.businessNumber = businessNumber;
    user.businessName = getBody.businessName;
    user.businessAddress = getBody.businessAddress;
    user.businessPhoneNumber = getBody.businessPhoneNumber;
    user.ip = getBody.ip;
    user.settleCondition = getBody.settleCondition;
    user.settleMethod = getBody.settleMethod;
    user.maximumLimit = getBody.maximumLimit;
    user.bankName = getBody.bankName;
    user.bankNumber = getBody.bankNumber;
    user.cardName = getBody.cardName;
    user.cardNumber = getBody.cardNumber;
    user.status = getBody.status;
    user.fromPhoneNumber = getBody.fromPhoneNumber;

    user.settlePeriodCondition = getBody.settlePeriodCondition;
    user.settlePeriodCount = getBody.settlePeriodCount;
    user.duplicatePhoneLimit = getBody.duplicatePhoneLimit ?? 0;

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

    await this.userRepository.save(user);

    return;
  }
}
