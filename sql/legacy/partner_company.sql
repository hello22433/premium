-- 발송일 포함여부
alter table partner_company
    ADD COLUMN validity_starts_next_day TINYINT(1) NOT NULL DEFAULT 1
  COMMENT '1: 유효기간 시작이 다음 날, 0: 발송(시작) 당일 포함';