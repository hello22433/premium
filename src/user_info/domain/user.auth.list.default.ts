import { IUserAuthority } from '../../user/interface/user.authority';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

export const UserAuthListDefault = (authority: IUserAuthority, authorityList: string | null): UserAuthSubEnum[] => {
  // SUPER_ADMIN은 저장된 authority_list 와 무관하게 항상 전체 권한.
  // 생성/수정 시 모든 역할이 authority_list 를 CSV 로 기록하므로, null 체크보다 먼저 분기해야
  // 화면에서 저장된 SUPER_ADMIN 도 전체 권한이 유지되고 신규 메뉴(FORBIDDEN_WORD 등)가 자동 포함된다.
  if (authority === IUserAuthority.SUPER_ADMIN) {
    return Object.values(UserAuthSubEnum);
  }

  if (authorityList !== null) {
    return authorityList.split(',') as UserAuthSubEnum[];
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
      UserAuthSubEnum.FORBIDDEN_WORD,
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
