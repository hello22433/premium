import { UserEntity } from '../../src/entity/user.entity';
import { IUserSettleCondition } from '../../src/user/interface/user.settle.condition';
import { IUserSettleMethod } from '../../src/user/interface/user.settle.method';
import { IUserStatus } from '../../src/user/interface/user.status';
import { IUserAuthority } from '../../src/user/interface/user.authority';
import { IUserBusinessType } from '../../src/user/interface/user.business.type';
import { CompanyType } from '../../src/common/domain/company.type';
import { LoginVerifyMethod } from '../../src/user/interface/login.verify.method';

export const UserEntityTest = (): UserEntity => {
  return {
    id: 0,
    companyId: null,
    company: null as any,
    departmentId: null,
    department: null as any,
    email: '',
    password: '',
    isPasswordReset: false,
    passwordChangedAt: null,
    authority: IUserAuthority.OPERATION_ADMIN,
    status: IUserStatus.USED,
    personName: '',
    personPhoneNumber: '',
    personEmail: '',
    personCode: '',
    personCategory: '',
    loginVerifyMethod: LoginVerifyMethod.EMAIL,
    businessType: IUserBusinessType.INDIVIDUAL,
    corporateNumber: null,
    isHeadPerson: false,
    ip: null,
    settleCondition: IUserSettleCondition.POST_PAYMENT,
    settleMethod: IUserSettleMethod.CARD,
    bankName: '',
    bankNumber: '',
    cardName: '',
    cardNumber: '',
    balance: 0,
    businessGrade: 'S+',
    fromPhoneNumber: null,
    settlePeriodCondition: null,
    settlePeriodCount: null,
    allSettleAmount: 0,
    serviceAmount: 0,
    duplicatePhoneLimit: 0,
    authorityList: null,
    apiKeyHash: null,
    allowedSendMethods: 'ALIM_TALK,MMS,EMAIL',
    documentCompanyType: CompanyType.ENMAD,
    orders: [],
    clientOrders: [],
    userDiscounts: [],
    viewScope: null as any,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
};
