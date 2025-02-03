import { UserEntity } from '../../src/entity/user.entity';
import { IUserSettleCondition } from '../../src/user/interface/user.settle.condition';
import { IUserSettleMethod } from '../../src/user/interface/user.settle.method';
import { IUserStatus } from '../../src/user/interface/user.status';
import { IUserAuthority } from '../../src/user/interface/user.authority';
import { IUserBusinessType } from '../../src/user/interface/user.business.type';

export const UserEntityTest = (): UserEntity => {
  return {
    businessType: IUserBusinessType.INDIVIDUAL,
    authority: IUserAuthority.OPERATION_ADMIN,
    balance: 0,
    bankName: '',
    bankNumber: '',
    businessAddress: '',
    businessName: '',
    businessNumber: '',
    businessPhoneNumber: '',
    cardName: '',
    cardNumber: '',
    corporateNumber: null,
    createdAt: new Date(),
    deletedAt: null,
    email: '',
    id: 0,
    ip: '',
    isPasswordReset: false,
    maximumLimit: 0,
    password: '',
    personCategory: '',
    personCode: '',
    personEmail: '',
    personName: '',
    personPhoneNumber: '',
    settleCondition: IUserSettleCondition.POST_PAYMENT,
    settleMethod: IUserSettleMethod.CARD,
    status: IUserStatus.USED,
    updatedAt: new Date(),
  };
};
