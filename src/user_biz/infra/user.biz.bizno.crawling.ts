import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { CrawlingResponse } from '../interface/user.bizno.crawling.response';

@Injectable()
export class UserBizBiznoCrawling {
  async getCrawling(bizNo: string): Promise<CrawlingResponse> {
    const response = {} as CrawlingResponse;
    const url = `https://bizno.net/article/${bizNo}`;

    try {
      const { data: html } = await axios.get(url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'ko-KR,kr;q=0.5',
          Connection: 'keep-alive',
          Host: 'bizno.net',
          Referer: 'https://bizno.net/',
          'Upgrade-Insecure-Requests': '1',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        },
      });

      const $ = cheerio.load(html);

      // 회사 이름 가져오기
      const companyName = this.getTextContent($('div.titles h1'));

      // 사업자 현재 상태 가져오기
      const companyStatus = this.getTextContent($('tr:contains(사업자 현재 상태) td span'));

      // 사업자등록번호 가져오기
      const bizNumber = this.getTextContent($('tr:contains(사업자등록번호) td span'));

      // 사업자 전화번호 가져오기
      const bizTell = this.getTextContent($('tr:contains(전화번호) td a'));

      // 회사 주소 가져오기
      const addressElement = $('tr:contains(회사주소) td');
      const address = this.extractAddress(addressElement);

      // 업태 가져오기
      const industryType = this.getTextContent($('tr:contains(업 태) td a'))
        || this.getTextContent($('tr:contains(업태) td a'));

      // 종목 가져오기
      const industryItem = this.getTextContent($('tr:contains(종 목) td a'))
        || this.getTextContent($('tr:contains(종목) td a'));

      const data: Record<string, string> = {};
      if (companyName && companyStatus && address && bizNumber) {
        if (companyStatus.includes('폐업')) {
          response.status_code = 'ERROR';
          data.error = '폐업자로 조회되는 사업자등록번호입니다';
        } else if (companyStatus.includes('휴업')) {
          response.status_code = 'ERROR';
          data.error = '휴업자로 조회되는 사업자등록번호입니다';
        } else {
          data.companyName = companyName;
          data.companyStatus = companyStatus;
          data.address = address;
          data.bizNumber = bizNumber;
          data.bizTell = bizTell ?? '';
          data.industryType = industryType ?? '';
          data.industryItem = industryItem ?? '';
          response.status_code = 'OK';
        }
      } else {
        const noResult1 = this.getTextContent($("h4 span[style='color: blue;font-size:10pt']"));
        if (noResult1 && noResult1.includes('국세청에 등록되지 않은 사업자등록번호')) {
          response.status_code = 'ERROR';
          data.error = '국세청에 등록되지 않은 사업자등록번호입니다';
        } else if (noResult1 && noResult1.includes('사업자상태 : 계속사업자')) {
          response.status_code = 'OK';
          data.bizNumber = bizNumber || '알 수 없는 번호';
          data.companyStatus = '계속사업자';
        } else {
          response.status_code = 'ERROR';
          data.error = '알 수 없는 오류가 발생했습니다';
        }
      }

      response.data = data;
    } catch (error) {
      throw new Error(`크롤링 중 오류가 발생했습니다: ${error.message}`);
    }

    return response;
  }

  getTextContent(element: cheerio.Cheerio<any>): string | null {
    return element?.text()?.trim() || null;
  }

  extractAddress(element: cheerio.Cheerio<any>): string | null {
    return element?.text()?.trim() || null;
  }
}
