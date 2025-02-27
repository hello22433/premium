import { Injectable } from '@nestjs/common';
import { UserBizBiznoCrawling } from '../infra/user.biz.bizno.crawling';
import { UserBizGetBuzInfoDto, UserBizGetBuzInfoResDto } from '../api/user.biz.res.dto';

@Injectable()
export class UserBizService {
  constructor(private userBizBiznoCrawling: UserBizBiznoCrawling) {}

  async getBuzInfo(bizNo: string) {
    const crawlingResponse = await this.userBizBiznoCrawling.getCrawling(bizNo);
    let data: UserBizGetBuzInfoDto | null = null;
    if (crawlingResponse.status_code === 'OK') {
      data = {
        businessName: crawlingResponse.data.companyName ?? '',
        businessAddress: crawlingResponse.data.address ?? '',
        businessNumber: crawlingResponse.data.bizNumber ?? '',
        businessPhoneNumber: crawlingResponse.data.bizTell ?? '',
      };
    }

    const res: UserBizGetBuzInfoResDto = {
      statusCode: crawlingResponse.status_code,
      data,
    };

    return res;
  }
}
