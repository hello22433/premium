import { IUserAuthority } from '../../user/interface/user.authority';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

export const UserAuthListDefault = (authority: IUserAuthority, authorityList: string | null): UserAuthSubEnum[] => {
  if (authorityList !== null) {
    return authorityList.split(',') as UserAuthSubEnum[];
  }

  if (authority === IUserAuthority.SUPER_ADMIN) {
    return Object.values(UserAuthSubEnum);
  }

  if (authority === IUserAuthority.OPERATION_ADMIN) {
    return [
      // 주문관리
      UserAuthSubEnum.ORDER_GENERAL,
      UserAuthSubEnum.ORDER_SSG,
      UserAuthSubEnum.ORDER_REAL_ITEM,

      // 발송관리
      UserAuthSubEnum.SEND_GENERAL,
      UserAuthSubEnum.SEND_SSG,
      UserAuthSubEnum.SEND_REAL_ITEM,

      // 고객관리
      UserAuthSubEnum.ACCOUNT,
      UserAuthSubEnum.PARTNER,
      UserAuthSubEnum.MANAGE_CLIENT,
      UserAuthSubEnum.CUSTOMER_GENERAL_COUPON,
      UserAuthSubEnum.CUSTOMER_SSG_COUPON,
      UserAuthSubEnum.CUSTOMER_REFUND,

      // 정산 관리
      UserAuthSubEnum.SERVICE_SALES,

      // 고객센터
      UserAuthSubEnum.NOTICE,
      UserAuthSubEnum.QNA,
      UserAuthSubEnum.DOCUMENT,

      //기타
      UserAuthSubEnum.IMS_PLAN,
      UserAuthSubEnum.ACTIVITY_LOG,
      UserAuthSubEnum.REQUIREMENT,
    ];
  }

  if (authority === IUserAuthority.CORPORATE_ADMIN) {
    return [
      UserAuthSubEnum.ORDER_GENERAL,
      UserAuthSubEnum.ORDER_SSG,
      UserAuthSubEnum.ORDER_REAL_ITEM,
      UserAuthSubEnum.QNA,
      UserAuthSubEnum.DOCUMENT,
    ];
  }

  return [];
};
