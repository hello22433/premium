// 전역 변수 설정
import { IPartnerCompanyType } from './partner_company/interface/partner.company.type';

export const PartnerCompanySSGType = IPartnerCompanyType.SSG;

export const EmailCertifyExpireMinute = 5;

export const EmailCertifyExpireDay = 30;

/** 자사(ePOPKON) 대표 발신번호. 시스템 메시지(로그인/비번찾기/계정알림) + ALIM_TALK + 레거시 null 발송 안전망 전용. */
export const systemFromPhoneNumber = '16443614';

/** @deprecated systemFromPhoneNumber 또는 OrderFromService.resolveSendDefaultPhone 사용. cutover 후 제거 예정. */
export const defaultFromPhoneNumber = systemFromPhoneNumber;

export const customerName = '모바일이앤엠애드';

export const ssgIssueUserName = '모바일이앤엠애드';

export const defaultOrderTopImagePath = 'https://epopkon-premium.s3.amazonaws.com/image/1740558623939-coupon-ttl.jpg';

export const defaultOrderMidImagePath = 'https://epopkon-premium.s3.amazonaws.com/image/1740558757718-mms_text_img.jpg';

export const choiceProductPartnerCompanyCode = '';

export const choiceProductPartnerCompanyId = 0;

export const choiceProductBrandId = 0;

export const choiceProductCategory = 'C';

export const choiceProductClassificationId = 1; // 기본 대분류 ID

export const choiceProductExpireDay = 60;

export const choiceProductSettlePercent = 30;

export const choiceProductSettleMethod = 'PER_EXCHANGE';

export const choiceProductCouponMethod = '';
