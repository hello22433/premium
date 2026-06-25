import { Controller, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Parser } from 'xml2js';
import { GalaxiaIpGuard } from './galaxia.ip.guard';
import { PartnerCompanyExternBatchService } from '../application/partner.company.extern.batch.service';

const SUCCESS_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>',
  '<Result>',
  '  <resCode>0000</resCode>',
  '  <resMsg>Success</resMsg>',
  '</Result>',
].join('\n');

const errorXml = (msg: string) =>
  [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>',
    '<Result>',
    `  <resCode>9999</resCode>`,
    `  <resMsg>${msg}</resMsg>`,
    '</Result>',
  ].join('\n');

@Controller('')
@ApiExcludeController()
export class GalaxiaPushController {
  private readonly logger = new Logger('GALAXIA_PUSH');
  private readonly xmlParser = new Parser({ explicitArray: false, trim: true });

  constructor(private readonly batchService: PartnerCompanyExternBatchService) {}

  @Post('external/galaxia/usage')
  @UseGuards(GalaxiaIpGuard)
  async handlePush(@Req() req: Request, @Res() res: Response) {
    res.set('Content-Type', 'application/xml');

    try {
      const body = req.body;
      if (!body || typeof body !== 'string') {
        this.logger.error('빈 요청 body');
        res.status(200).send(errorXml('Empty body'));
        return;
      }

      const parsed = await this.xmlParser.parseStringPromise(body);
      const root = parsed?.Result;
      if (!root) {
        this.logger.error(`XML 파싱 실패: <Result> 없음, keys=${Object.keys(parsed ?? {}).join(',')}`);
        res.status(200).send(errorXml('Invalid XML'));
        return;
      }

      // transaction이 1개면 객체, 여러 개면 배열
      let transactions = root.transaction;
      if (!transactions) {
        this.logger.warn('transaction 없음');
        res.status(200).send(SUCCESS_XML);
        return;
      }
      if (!Array.isArray(transactions)) {
        transactions = [transactions];
      }

      const clientIp = (req as any).galaxiaClientIp || '';
      const giftKind = GalaxiaIpGuard.getGiftKindByIp(clientIp);

      this.logger.log(`Push 수신: ${transactions.length}건, IP=${clientIp}, giftKind=${giftKind}`);

      let successCount = 0;
      let skipCount = 0;
      let errorCount = 0;

      for (const tx of transactions) {
        try {
          const result = await this.batchService.processGalaxiaPush(tx, giftKind);
          if (result === 'saved') successCount++;
          else skipCount++;
        } catch (e) {
          errorCount++;
          this.logger.error(`Push 처리 오류: ${e}`);
        }
      }

      this.logger.log(`Push 처리 완료: 저장=${successCount}, 스킵=${skipCount}, 오류=${errorCount}`);
      res.status(200).send(SUCCESS_XML);
    } catch (e) {
      this.logger.error(`Push 전체 오류: ${e}`);
      res.status(200).send(errorXml('Internal error'));
    }
  }
}
