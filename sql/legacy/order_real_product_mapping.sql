-- order_real_product_mapping 테이블의 public_charge_tax_payment 컬럼에 'NONE' enum 값 추가
-- 실행 전 반드시 백업 후 진행할 것

-- MySQL/MariaDB용 ALTER TABLE 문
ALTER TABLE order_real_product_mapping
MODIFY COLUMN public_charge_tax_payment ENUM('NONE', 'PERSON', 'COMPANY') NULL;

-- 참고: 기존 데이터는 유지됨 (PERSON, COMPANY 값들은 그대로 보존)
-- 새로 추가된 'NONE' 옵션은 기준가 5만원 이하인 경우 "해당없음"을 표시하기 위한 값
