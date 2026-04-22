import { Body, Controller, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { format } from 'date-fns';
import { GiftielIpGuard } from './giftiel.ip.guard';
import { GiftielExchangeReqDto } from './dto/giftiel.exchange.req.dto';
import { GiftielExchangeResDto } from './dto/giftiel.exchange.res.dto';
import { PartnerCompanyExternBatchService } from '../application/partner.company.extern.batch.service';

@Controller('')
@ApiExcludeController()
export class GiftielPushController {
  private readonly logger = new Logger('GIFTIEL_PUSH');

  constructor(private readonly batchService: PartnerCompanyExternBatchService) {}

  @Post('external/giftiel/exchange')
  @UseGuards(GiftielIpGuard)
  async handlePush(@Req() req: Request, @Body() body: GiftielExchangeReqDto, @Res() res: Response): Promise<void> {
    const clientIp = (req as any).giftielClientIp || '';
    this.logger.log(
      `[giftielPush] 수신: cmdType=${body.CmdType}, trId=${body.TrID}, couponNumber=${body.CouponNumber}, authDate=${body.AuthDate}, IP=${clientIp}`,
    );

    const baseRes = {
      ServCode: body.ServCode,
      TrID: body.TrID,
      DateTime: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
    };

    // Giftiel은 flat JSON을 요구하므로 @Res로 직접 응답 (TransformResInterceptor 우회)
    try {
      const result = await this.batchService.processGiftielPush(body, clientIp);
      this.logger.log(`[giftielPush] 처리 완료: ${result}, trId=${body.TrID}`);
      const successRes: GiftielExchangeResDto = { ...baseRes, result_code: '0000', result_msg: 'success' };
      res.status(200).json(successRes);
    } catch (e: any) {
      this.logger.error(`[giftielPush] 오류: trId=${body.TrID}, message=${e?.message}`);
      const errorRes: GiftielExchangeResDto = { ...baseRes, result_code: '9999', result_msg: 'server internal error' };
      res.status(200).json(errorRes);
    }
  }
}
