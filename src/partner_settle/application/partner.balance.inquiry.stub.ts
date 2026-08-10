import { Injectable } from '@nestjs/common';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import {
  assertBalanceInvariant,
  IPartnerBalanceInquiry,
  PartnerBalanceResult,
} from '../interface/partner.balance.inquiry';
import { GALAXIA_SUB_ITEM_ORDER } from '../domain/credit.row.axis';

/**
 * 갤럭시아 여신한도 조회 stub.
 *
 * 갤럭시아 `limitPrice` 실연동 전까지 모든 하위항목에 `NOT_AVAILABLE`
 * (화면 "연동 대기")을 반환한다.
 */

@Injectable()
export class GalaxiaBalanceInquiryStub implements IPartnerBalanceInquiry {
  readonly provider = IPartnerCompanyType.GALAXIA;

  async getBalances(): Promise<PartnerBalanceResult[]> {
    return GALAXIA_SUB_ITEM_ORDER.map((key) => notAvailable(key));
  }
}

function notAvailable(subItemKey: string): PartnerBalanceResult {
  return assertBalanceInvariant({
    subItemKey,
    status: 'NOT_AVAILABLE',
    balance: null,
    reason: '협력사 여신한도 조회 미연동 (연동 대기)',
  });
}
