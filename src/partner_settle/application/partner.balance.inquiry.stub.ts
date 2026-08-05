import { Injectable } from '@nestjs/common';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import {
  assertBalanceInvariant,
  IPartnerBalanceInquiry,
  PartnerBalanceResult,
} from '../interface/partner.balance.inquiry';
import { GALAXIA_SUB_ITEM_ORDER } from '../domain/credit.row.axis';
import { SUB_ITEM_KEY_NONE } from '../domain/settle.sub.item.key';

/**
 * 케이티알파·갤럭시아 여신한도 조회 stub (정본 §4.3 · §9.1 · D-BAL).
 *
 * `기프티쇼 한도조회 규격서`·갤럭시아 `limitPrice` 실연동 전까지 전 하위항목 `NOT_AVAILABLE`
 * (화면 "연동 대기")을 반환한다. 실연동 adapter 로 교체하면 소비 계약은 그대로다.
 */
@Injectable()
export class GiftShowBalanceInquiryStub implements IPartnerBalanceInquiry {
  readonly provider = IPartnerCompanyType.GIFT_SHOW;

  async getBalances(): Promise<PartnerBalanceResult[]> {
    return [notAvailable(SUB_ITEM_KEY_NONE)];
  }
}

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
