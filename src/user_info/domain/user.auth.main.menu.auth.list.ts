// 받은 서브메뉴를 통해 main Menu 까지 return 하는 함수
import { UserAuthMainEnum, UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

export const UserAuthMainMenuAuthList = (userSubmenuAuthList: UserAuthSubEnum[]): UserAuthMainEnum[] => {
  if (userSubmenuAuthList.length === 0) {
    return [];
  }

  const mainMenuSet = new Set<UserAuthMainEnum>();

  for (const subMenu of userSubmenuAuthList) {
    if (subMenu === UserAuthSubEnum.ORDER_GENERAL) {
      mainMenuSet.add(UserAuthMainEnum.ORDER);
    }
    if (subMenu === UserAuthSubEnum.ORDER_SSG) {
      mainMenuSet.add(UserAuthMainEnum.ORDER);
    }
    if (subMenu === UserAuthSubEnum.ORDER_REAL_ITEM) {
      mainMenuSet.add(UserAuthMainEnum.ORDER);
    }

    if (subMenu === UserAuthSubEnum.SEND_GENERAL) {
      mainMenuSet.add(UserAuthMainEnum.SEND);
    }

    if (subMenu === UserAuthSubEnum.SEND_SSG) {
      mainMenuSet.add(UserAuthMainEnum.SEND);
    }

    if (subMenu === UserAuthSubEnum.SEND_REAL_ITEM) {
      mainMenuSet.add(UserAuthMainEnum.SEND);
    }

    if (subMenu === UserAuthSubEnum.SEND_FAIL_HISTORY) {
      mainMenuSet.add(UserAuthMainEnum.SEND);
    }

    if (subMenu === UserAuthSubEnum.PRODUCT_LIST) {
      mainMenuSet.add(UserAuthMainEnum.PRODUCT);
    }

    if (subMenu === UserAuthSubEnum.PRODUCT_CUSTOMER_LINK_ITEM) {
      mainMenuSet.add(UserAuthMainEnum.PRODUCT);
    }

    if (subMenu === UserAuthSubEnum.PRODUCT_CHOICE) {
      mainMenuSet.add(UserAuthMainEnum.PRODUCT);
    }

    if (subMenu === UserAuthSubEnum.ACCOUNT) {
      mainMenuSet.add(UserAuthMainEnum.CUSTOMER);
    }

    if (subMenu === UserAuthSubEnum.PARTNER) {
      mainMenuSet.add(UserAuthMainEnum.CUSTOMER);
    }

    if (subMenu === UserAuthSubEnum.MANAGE_CLIENT) {
      mainMenuSet.add(UserAuthMainEnum.CUSTOMER);
    }

    if (subMenu === UserAuthSubEnum.CUSTOMER_GENERAL_COUPON) {
      mainMenuSet.add(UserAuthMainEnum.CUSTOMER);
    }

    if (subMenu === UserAuthSubEnum.CUSTOMER_SSG_COUPON) {
      mainMenuSet.add(UserAuthMainEnum.CUSTOMER);
    }

    if (subMenu === UserAuthSubEnum.CUSTOMER_REFUND) {
      mainMenuSet.add(UserAuthMainEnum.CUSTOMER);
    }

    if (subMenu === UserAuthSubEnum.SERVICE_SALES) {
      mainMenuSet.add(UserAuthMainEnum.SETTLEMENT);
    }

    if (subMenu === UserAuthSubEnum.PROFIT) {
      mainMenuSet.add(UserAuthMainEnum.SETTLEMENT);
    }

    if (subMenu === UserAuthSubEnum.SETTLE_PARTNER_COMPANY) {
      mainMenuSet.add(UserAuthMainEnum.SETTLEMENT);
    }

    if (subMenu === UserAuthSubEnum.SETTLE_USER) {
      mainMenuSet.add(UserAuthMainEnum.SETTLEMENT);
    }

    if (subMenu === UserAuthSubEnum.SETTLE_USER_MANAGE) {
      mainMenuSet.add(UserAuthMainEnum.SETTLEMENT);
    }

    if (subMenu === UserAuthSubEnum.REFILL_SSG) {
      mainMenuSet.add(UserAuthMainEnum.SETTLEMENT);
    }

    if (subMenu === UserAuthSubEnum.SETTLEMENT_CODE) {
      mainMenuSet.add(UserAuthMainEnum.SETTLEMENT);
    }

    if (subMenu === UserAuthSubEnum.NOTICE) {
      mainMenuSet.add(UserAuthMainEnum.CUSTOMER_SERVICE);
    }

    if (subMenu === UserAuthSubEnum.QNA) {
      mainMenuSet.add(UserAuthMainEnum.CUSTOMER_SERVICE);
    }

    if (subMenu === UserAuthSubEnum.DOCUMENT) {
      mainMenuSet.add(UserAuthMainEnum.CUSTOMER_SERVICE);
    }

    if (subMenu === UserAuthSubEnum.IMS_PLAN) {
      mainMenuSet.add(UserAuthMainEnum.ETC);
    }

    if (subMenu === UserAuthSubEnum.ACTIVITY_LOG) {
      mainMenuSet.add(UserAuthMainEnum.ETC);
    }

    if (subMenu === UserAuthSubEnum.REQUIREMENT) {
      mainMenuSet.add(UserAuthMainEnum.ETC);
    }

    if (subMenu === UserAuthSubEnum.FORBIDDEN_WORD) {
      mainMenuSet.add(UserAuthMainEnum.ETC);
    }
  }

  return [...mainMenuSet];
};
