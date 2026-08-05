export enum UserAuthMainEnum {
  ORDER = 'ORDER', // 주문관리
  SEND = 'SEND', // 발송관리
  PRODUCT = 'PRODUCT', //상품관리
  CUSTOMER = 'CUSTOMER', //고객관리
  SETTLEMENT = 'SETTLEMENT', // 정산관리
  CUSTOMER_SERVICE = 'CUSTOMER_SERVICE', // 고객센터
  ETC = 'ETC', // 기타
}

export enum UserAuthSubEnum {
  // 주문관리
  ORDER_GENERAL = 'ORDER_GENERAL', // 일반쿠폰 주문
  ORDER_SSG = 'ORDER_SSG', // 신세계 주문
  ORDER_REAL_ITEM = 'ORDER_REAL_ITEM', // 실물 상품 주문
  ORDER_RECEIPT = 'ORDER_RECEIPT', // 주문접수
  ORDER_EXTERNAL = 'ORDER_EXTERNAL', // 외부 주문

  // 발송 관리
  SEND_GENERAL = 'SEND_GENERAL', // 일반쿠폰 발송
  SEND_SSG = 'SEND_SSG', // 신세계 발송
  SEND_REAL_ITEM = 'SEND_REAL_ITEM', // 실물 상품 발송
  SEND_FAIL_HISTORY = 'SEND_FAIL_HISTORY', // 발송 실패 이력

  // 상품 관리
  PRODUCT_LIST = 'PRODUCT_LIST', // 상품 조회
  PRODUCT_CUSTOMER_LINK_ITEM = 'LINK_ITEM', // 고객상품 관리
  PRODUCT_CHOICE = 'PRODUCT_CHOICE', // 초이스 쿠폰 관리

  // 고객 관리
  ACCOUNT = 'ACCOUNT', // 계정관리
  PARTNER = 'PARTNER', // 협력사 관리
  MANAGE_CLIENT = 'MANAGE_CLIENT', // 고객 관리
  CUSTOMER_GENERAL_COUPON = 'CUSTOMER_GENERAL_COUPON', // 일반 쿠폰 주문 CS
  CUSTOMER_SSG_COUPON = 'CUSTOMER_SSG_COUPON', // 신세계 주문 CS
  CUSTOMER_REFUND = 'CUSTOMER_REFUND', // 환불 관리

  // 정산 관리
  SERVICE_SALES = 'SERVICE_SALES', // 기타 서비스 매출
  PROFIT = 'PROFIT', // 수익률 조회
  SETTLE_PARTNER_COMPANY = 'SETTLE_PARTNER_COMPANY', // 협력사별 정산
  SETTLE_USER = 'SETTLE_USER', // 고객사별 정산
  SETTLE_USER_MANAGE = 'SETTLE_USER_MANAGE', // 고객사별 정산 관리
  REFILL_SSG = 'REFILL_SSG', // 신세계 충전
  SETTLEMENT_CODE = 'SETTLEMENT_CODE', // 정산코드 관리
  SETTLE_CREDIT = 'SETTLE_CREDIT', // 여신관리 탭 조회 + 월한도 설정 (PR2)

  // 고객 센터
  NOTICE = 'NOTICE', // 공지사항
  QNA = 'QNA', // 1:1문의
  DOCUMENT = 'DOCUMENT', // 문서함

  // 기타
  IMS_PLAN = 'IMS_PLAN', // IMS 추진일정
  ACTIVITY_LOG = 'ACTIVITY_LOG', // 로그 조회
  REQUIREMENT = 'REQUIREMENT', // 개발 요구사항
  FORBIDDEN_WORD = 'FORBIDDEN_WORD', // 금칙어 관리
}
