-- ---------------------------------------------------------------------------
-- PR3A — 지급 차이(PAYMENT_VARIANCE) 승인·반려
--
-- 정본 §5 220행 · §5.7.2. PR1B(20260804_partner_credit_pr1b_ledger.sql)가
-- `partner_settle_ledger.payment_variance_proposal_id` 를 "FK·CHECK 일체는 PR3" 로 유예했고,
-- PR1D(20260807_partner_settle_pr1d_confirm.sql)가 proposal 테이블을 만들었다.
-- 이 마이그레이션은 그 유예분(provenance 제약)을 채운다.
--
-- 적용 순서: PR1B → PR1D → 이 파일.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. partner_settle_ledger — variance provenance
-- ---------------------------------------------------------------------------

-- proposal 당 결과 원장 1건. 승인 재시도가 두 번째 ADJUSTMENT 를 만들지 못한다.
ALTER TABLE `partner_settle_ledger`
  ADD UNIQUE KEY `uk_partner_settle_ledger_payment_variance` (`payment_variance_proposal_id`);

-- proposal 의 result 복합 FK 가 참조할 대상. (id, proposalId, partnerCompanyId) 3열이 함께 맞아야
-- 다른 협력사의 원장을 result 로 붙일 수 없다.
ALTER TABLE `partner_settle_ledger`
  ADD UNIQUE KEY `uk_partner_settle_ledger_variance_provenance`
    (`id`, `payment_variance_proposal_id`, `partner_company_id`);

ALTER TABLE `partner_settle_ledger`
  ADD CONSTRAINT `fk_partner_settle_ledger_payment_variance`
    FOREIGN KEY (`payment_variance_proposal_id`)
    REFERENCES `partner_settle_payment_variance_proposal` (`id`);

-- variance ADJUSTMENT 의 형태를 DB 가 고정한다 (정본 §5 220행).
-- 하나라도 어긋난 row 는 INSERT 자체가 거부되므로, 서비스 버그가 여신 표·확정 sweep 에
-- 이상한 sentinel row 를 흘려보낼 수 없다.
ALTER TABLE `partner_settle_ledger`
  ADD CONSTRAINT `chk_partner_settle_ledger_variance_shape` CHECK (
    `payment_variance_proposal_id` IS NULL OR (
      `source_type` = 'ADJUSTMENT'
      AND `sub_item_key` = 'PAYMENT_VARIANCE'
      AND `idempotency_key` = CONCAT('PAYMENT_VARIANCE:', `payment_variance_proposal_id`)
      AND `settle_batch_id` IS NULL
      AND `status` = 'NORMAL'
      AND `pricing_resolution` = 'DIRECT_AMOUNT'
      AND `base_amount` = `settle_amount`
      AND `occurred_at` IS NOT NULL
    )
  );

-- 역방향: sentinel 은 variance 전용이다. 일반 원장·수동/할인 조정·정산조건 matcher 가
-- 'PAYMENT_VARIANCE' 를 하위항목으로 쓰는 것을 금지한다 (정본 §5 163행).
ALTER TABLE `partner_settle_ledger`
  ADD CONSTRAINT `chk_partner_settle_ledger_variance_sentinel` CHECK (
    `sub_item_key` <> 'PAYMENT_VARIANCE' OR `payment_variance_proposal_id` IS NOT NULL
  );

-- ---------------------------------------------------------------------------
-- 2. partner_settle_payment_variance_proposal — result provenance
-- ---------------------------------------------------------------------------

-- 승인 결과 원장이 (a) 이 proposal 을 provenance 로 갖고 (b) 같은 협력사인지 DB 가 강제한다.
-- 방향상 ledger INSERT 후 proposal UPDATE 순서만 성립한다(정본 §5.7.2 승인 transaction 순서).
ALTER TABLE `partner_settle_payment_variance_proposal`
  ADD CONSTRAINT `fk_variance_result_ledger`
    FOREIGN KEY (`result_ledger_id`, `id`, `partner_company_id`)
    REFERENCES `partner_settle_ledger` (`id`, `payment_variance_proposal_id`, `partner_company_id`);
