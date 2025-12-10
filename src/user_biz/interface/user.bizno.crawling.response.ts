export interface CrawlingResponse {
  status_code: 'OK' | 'ERROR';
  data: {
    error?: string; // 에러 메시지는 선택적으로 존재
    companyName?: string; // 회사명
    companyStatus?: string; // 회사 상태
    address?: string; // 회사 주소
    bizNumber?: string; // 사업자번호
    bizTell?: string; // 전화번호
    industryType?: string; // 업태
    industryItem?: string; // 종목
  };
}
