import { BadRequestException, Injectable } from '@nestjs/common';
import { UserEntity } from '../../entity/user.entity';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import {
  UserManagementChargeBalanceReqDto,
  UserManagementCreateReqDto,
  UserManagementGetDetailReqParamDto,
  UserManagementGetListReqQueryDto,
  UserManagementGetNameListReqQueryDto,
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

@Injectable()
export class UserManagementService {
  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private passwordEncrypt: PasswordBcryptEncrypt,
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

    await this.userRepository.insert({
      email: getBody.email,
      password: passwordEncrypt,
      authority: getBody.authority,
      personName: getBody.personName,
      personPhoneNumber: getBody.personPhoneNumber,
      personEmail: getBody.personEmail,
      corporateNumber: getBody.corporateNumber,
      businessType: getBody.businessType,
      businessNumber: getBody.businessNumber,
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
      personCode: 'test1234', // TODO
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

    user.authority = getBody.authority;
    user.personName = getBody.personName;
    user.personPhoneNumber = getBody.personPhoneNumber;
    user.personEmail = getBody.personEmail;
    user.corporateNumber = getBody.corporateNumber;
    user.businessType = getBody.businessType;
    user.businessNumber = getBody.businessNumber;
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

    await this.userRepository.save(user);

    return;
  }
}
