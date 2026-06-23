-- user_discount 조회 성능 개선
-- findMatchingDiscount() 호출 경로(외부 API + 일반 주문 정산)에서
-- userId / partnerCompanyId 단건 또는 In() 검색이 빈번하므로 인덱스 추가.

ALTER TABLE user_discount ADD INDEX idx_user_discount_user (user_id);
ALTER TABLE user_discount ADD INDEX idx_user_discount_partner (partner_company_id);
