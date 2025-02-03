import { PartnerCompanyEntity } from '../../src/entity/partner.company.entity';
import { IPartnerCompanySettleMethod } from '../../src/partner_company/interface/partner.company.settle.method';
import { IPartnerCompanySettleCondition } from '../../src/partner_company/interface/partner.company.settle.condition';
import { IPartnerCompanyStatus } from '../../src/partner_company/interface/partner.company.status';
import { IPartnerCompanyType } from '../../src/partner_company/interface/partner.company.type';

export const PartnerCompanyEntityTest = (): PartnerCompanyEntity => {
  return {
    bankName: '',
    bankNumber: '',
    businessAddress: '',
    businessName: '',
    businessNumber: '',
    businessPhoneNumber: '',
    code: '',
    corporateNumber: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    id: 0,
    maximumLimit: 0,
    personEmail: '',
    personName: '',
    personPhoneNumber: '',
    settleCondition: IPartnerCompanySettleCondition.PRE_PAYMENT,
    settleDay: 10,
    settleMethod: IPartnerCompanySettleMethod['CARD'],
    status: IPartnerCompanyStatus.ACTIVE,
    type: IPartnerCompanyType.GALAXIA,
  };
};
