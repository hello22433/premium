/**
 * 회사 타입 Enum
 * PDF 문서 발행 시 회사별 양식 선택에 사용
 */
export enum CompanyType {
  ENMAD = 'ENMAD', // 모바일이앤엠애드
  SYSCUSS = 'SYSCUSS', // 시스커스
}

/**
 * 회사별 정보 인터페이스
 */
export interface ICompanyInfo {
  code: CompanyType;
  name: string; // 회사명
  fullName: string; // 회사명 (정식)
  businessNumber: string; // 사업자등록번호
  ceo: string; // 대표이사
  address: string; // 주소
  tel: string; // 전화번호
  fax: string; // 팩스번호
  email: string; // 이메일
  website: string; // 웹사이트
  color: {
    // 메인 색상 (RGB)
    r: number;
    g: number;
    b: number;
    hex: string;
  };
  logo: string; // 로고 이미지 경로
  stamp: string; // 직인 이미지 경로
  description: string; // 회사 설명 (푸터용)
}

/**
 * 회사별 정보 상수
 */
export const COMPANY_INFO: Record<CompanyType, ICompanyInfo> = {
  [CompanyType.ENMAD]: {
    code: CompanyType.ENMAD,
    name: '모바일이앤엠애드',
    fullName: '(주)모바일이앤엠애드',
    businessNumber: '215-87-19169',
    ceo: '추민기',
    address: '서울시 송파구 법원로9길 26, 씨동 1303호(문정동, 에이치비즈니스파크)',
    tel: '1644-3614',
    fax: '02-401-0730',
    email: 'service@enmad.com',
    website: 'www.enmad.com',
    color: {
      r: 255,
      g: 0,
      b: 0,
      hex: '#FF0000',
    },
    logo: '/img/color_logo.jpg',
    stamp: '/img/enm_stamp.png',
    description:
      '(주)모바일이앤엠애드는 모바일커머스, 모바일광고, 모바일솔루션, 모바일시스템을 결합한 디지털모바일마케팅 전문기업입니다.',
  },
  [CompanyType.SYSCUSS]: {
    code: CompanyType.SYSCUSS,
    name: '시스커스',
    fullName: '(주)시스커스',
    businessNumber: '532-86-01645',
    ceo: '성은정',
    address: '경기도 화성시 동탄대로23길 121 1동 11층 1108호',
    tel: '02-711-7911',
    fax: '02-401-0730',
    email: 'sales@syscuss.com',
    website: 'www.syscuss.com',
    color: {
      r: 25,
      g: 91,
      b: 169,
      hex: '#195BA9',
    },
    logo: '/img/syscuss/color_logo_syscuss.jpg',
    stamp: '/img/syscuss/syscuss_stamp.png',
    description: '(주)시스커스는 글로벌서비스, 모바일솔루션, 모바일시스템을 결합한 통합마케팅 전문기업입니다.',
  },
};

/**
 * 회사 타입 기본값
 */
export const DEFAULT_COMPANY_TYPE = CompanyType.ENMAD;

/**
 * 모바일이앤엠애드 사업자등록번호 (DB 저장 형식: 하이픈 없음)
 * DB에는 하이픈 제거 후 저장되므로 쿼리 비교용으로 사용
 */
export const ENMAD_BUSINESS_NUMBER = COMPANY_INFO[CompanyType.ENMAD].businessNumber.replace(/-/g, '');

/**
 * 시스커스 사업자등록번호 (DB 저장 형식: 하이픈 없음)
 */
export const SYSCUSS_BUSINESS_NUMBER = COMPANY_INFO[CompanyType.SYSCUSS].businessNumber.replace(/-/g, '');

/** 사이드바 알림 등에서 제외할 내부 회사 사업자등록번호 목록 */
export const INTERNAL_BUSINESS_NUMBERS = [ENMAD_BUSINESS_NUMBER, SYSCUSS_BUSINESS_NUMBER];

/**
 * 회사 정보 조회 헬퍼 함수
 */
export function getCompanyInfo(companyType: CompanyType): ICompanyInfo {
  return COMPANY_INFO[companyType] || COMPANY_INFO[DEFAULT_COMPANY_TYPE];
}

/**
 * 회사 타입 유효성 검사
 */
export function isValidCompanyType(value: string): value is CompanyType {
  return Object.values(CompanyType).includes(value as CompanyType);
}
