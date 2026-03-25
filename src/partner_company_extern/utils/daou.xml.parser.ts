import { Parser } from 'xml2js';
import { DaouXmlResponse } from '../interface/daou';

/**
 * 다우기술 XML 응답 파서
 * Java의 daouXmlParser 로직을 TypeScript로 변환
 */
export class DaouXmlParser {
  private parser: Parser;

  constructor() {
    this.parser = new Parser({
      explicitArray: false, // 배열 형태가 아닌 단일 값으로 파싱
      ignoreAttrs: false, // 속성 무시하지 않음
      trim: true, // 공백 제거
    });
  }

  /**
   * XML 문자열을 파싱하여 DaouXmlResponse 객체로 변환
   */
  async parse(xmlString: string): Promise<DaouXmlResponse> {
    try {
      // XML 문자열 앞뒤 공백 제거
      const trimmedXml = xmlString.trim();

      // XML 파싱
      const result = await this.parser.parseStringPromise(trimmedXml);

      // XML 구조에서 데이터 추출
      const response: DaouXmlResponse = {};

      // 재귀적으로 XML 요소 탐색
      this.extractValues(result, response);

      return response;
    } catch (error) {
      throw new Error(`Failed to parse DAOU XML: ${error}`);
    }
  }

  /**
   * 재귀적으로 XML 객체를 순회하며 필요한 값 추출
   * Java의 daouXmlParser 재귀 로직 구현
   */
  private extractValues(obj: any, response: DaouXmlResponse): void {
    if (!obj || typeof obj !== 'object') {
      return;
    }

    // 객체의 모든 키 순회
    for (const key in obj) {
      const value = obj[key];

      // 원하는 키를 찾으면 response에 저장
      if (key === 'RT' && value && typeof value === 'string') {
        response.RT = value.trim();
      } else if (key === 'RTMSG' && value && typeof value === 'string') {
        response.RTMSG = value.trim();
      } else if (key === 'NO_CPN' && value && typeof value === 'string') {
        response.NO_CPN = value.trim();
      } else if (key === 'TS_ID' && value && typeof value === 'string') {
        response.TS_ID = value.trim();
      } else if (key === 'CPN_STATUS' && value && typeof value === 'string') {
        response.CPN_STATUS = value.trim();
      } else if (key === 'USE_DATE' && value && typeof value === 'string') {
        response.USE_DATE = value.trim();
      } else if (key === 'USE_STORE' && value && typeof value === 'string') {
        response.USE_STORE = value.trim();
      }

      // 값이 객체이거나 배열이면 재귀 호출
      if (typeof value === 'object') {
        this.extractValues(value, response);
      }
    }
  }

  /**
   * 전체 상품 정보 XML 응답 파싱
   * 기존 parse()와 별도 — GOODS_LIST > GOODS_INFO[] 배열 구조 처리
   */
  async parseGoodsInfo(
    xmlString: string,
  ): Promise<{
    rt: string;
    rtmsg: string;
    listCount: number;
    goodsList: Record<string, string>[];
  }> {
    try {
      const trimmedXml = xmlString.trim();
      const result = await this.parser.parseStringPromise(trimmedXml);

      const cjService = result.CJSERVICE;
      const rt = cjService?.RT || '';
      const rtmsg = cjService?.RTMSG || '';
      const listCount = parseInt(cjService?.LIST_COUNT || '0', 10);

      // GOODS_LIST null 가드: 없거나 문자열이면 빈 배열
      const goodsList = cjService?.GOODS_LIST;
      if (!goodsList || typeof goodsList !== 'object') {
        return { rt, rtmsg, listCount, goodsList: [] };
      }

      // GOODS_INFO 배열 정규화 (explicitArray: false 대응)
      const rawItems = goodsList.GOODS_INFO;
      let items: Record<string, string>[];
      if (!rawItems) {
        items = [];
      } else if (Array.isArray(rawItems)) {
        items = rawItems;
      } else {
        items = [rawItems];
      }

      return { rt, rtmsg, listCount, goodsList: items };
    } catch (error) {
      throw new Error(`Failed to parse DAOU GoodsInfo XML: ${error}`);
    }
  }
}
