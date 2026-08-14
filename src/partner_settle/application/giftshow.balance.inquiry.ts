import { Injectable } from '@nestjs/common';
import { GiftishowHttp } from '../../partner_company_extern/infra/giftishow.http';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import {
  assertBalanceInvariant,
  IPartnerBalanceInquiry,
  PartnerBalanceResult,
} from '../interface/partner.balance.inquiry';
import { SUB_ITEM_KEY_NONE } from '../domain/settle.sub.item.key';

/** KT알파(기프티쇼) 기업고객 포인트 잔액(0305)을 여신 표 형식으로 변환한다. */
@Injectable()
export class GiftShowBalanceInquiry implements IPartnerBalanceInquiry {
  readonly provider = IPartnerCompanyType.GIFT_SHOW;

  constructor(private readonly giftishow: GiftishowHttp) {}

  async getBalances(): Promise<PartnerBalanceResult[]> {
    try {
      const response = await this.giftishow.getCompanyBalance();
      if (response.resCode !== '0000') {
        return [failed(`KT알파 잔액 조회 실패: ${response.resCode} ${response.resMsg}`)];
      }

      const balance = response.pointCompanyBalance?.usePosblAmt;
      if (!isNonNegativeInteger(balance)) {
        return [failed('KT알파 잔액 조회 응답의 usePosblAmt가 유효하지 않습니다')];
      }

      return [
        assertBalanceInvariant({
          subItemKey: SUB_ITEM_KEY_NONE,
          status: 'AVAILABLE',
          balance: BigInt(balance).toString(),
          fetchedAt: new Date().toISOString(),
        }),
      ];
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return [failed(`KT알파 잔액 조회 호출 실패: ${reason}`)];
    }
  }
}

function failed(reason: string): PartnerBalanceResult {
  return assertBalanceInvariant({
    subItemKey: SUB_ITEM_KEY_NONE,
    status: 'FAILED',
    balance: null,
    reason,
  });
}

function isNonNegativeInteger(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}
