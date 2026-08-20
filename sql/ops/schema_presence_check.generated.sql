-- 자동 생성 (sql/ops/gen_schema_presence_check.js). 읽기 전용 — DDL/DML 없음.
-- 대상 DB 에 접속해 그대로 실행한다. status='MISSING' 인 행이 미적용분이다.
--
-- 판정 대상: 마이그레이션이 만드는 테이블/컬럼/인덱스/CHECK/FK.
--   - 나중 마이그레이션이 DROP 하는 객체는 기대 목록에서 제외했다(있으면 오히려 이상).
--   - CHECK/FK 는 인덱스 카탈로그가 아니라 제약 카탈로그에서 확인한다.
-- 한계: 백필 전용 마이그레이션은 DDL 이 없어 이 목록에 나오지 않는다(별도 확인 필요).

WITH expected AS (
  SELECT 'sql/migrations/20241230_expand_person_email.sql' AS file, 'INDEX' AS kind, 'email_send_history' AS tbl, 'idx_email_send_history_user_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20241230_expand_person_email.sql' AS file, 'COLUMN' AS kind, 'email_send_history' AS tbl, 'user_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20251230_department_view_scope.sql' AS file, 'TABLE' AS kind, 'department' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20251230_department_view_scope.sql' AS file, 'TABLE' AS kind, 'user_view_scope' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20251230_department_view_scope.sql' AS file, 'COLUMN' AS kind, 'user' AS tbl, 'department_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20251230_department_view_scope.sql' AS file, 'FK' AS kind, 'user' AS tbl, 'FK_user_department_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260109_add_original_delivery_target.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'original_delivery_target' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260212_create_requirement_tables.sql' AS file, 'TABLE' AS kind, 'requirement' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260212_create_requirement_tables.sql' AS file, 'TABLE' AS kind, 'requirement_comment' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260212_create_requirement_tables.sql' AS file, 'TABLE' AS kind, 'requirement_attachment' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260309_add_order_card_surcharge.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'card_surcharge_applied' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260309_add_product_shared_list_file.sql' AS file, 'TABLE' AS kind, 'product_shared_list_file' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260309_add_user_document_company_type.sql' AS file, 'COLUMN' AS kind, 'user' AS tbl, 'document_company_type' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260330_discount_option_redesign.sql' AS file, 'COLUMN' AS kind, 'user_discount' AS tbl, 'classification_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260406_create_early_destroy_request.sql' AS file, 'TABLE' AS kind, 'early_destroy_request' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260406_create_early_destroy_request.sql' AS file, 'TABLE' AS kind, 'early_destroy_request_item' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260408_add_order_delivery_claimed_at.sql' AS file, 'INDEX' AS kind, 'order_delivery' AS tbl, 'idx_order_delivery_claim' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260408_add_order_delivery_claimed_at.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'claimed_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260408_create_pin_issue_dedup.sql' AS file, 'TABLE' AS kind, 'pin_issue_dedup' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260409_add_pin_issue_dedup_recovered_from.sql' AS file, 'COLUMN' AS kind, 'pin_issue_dedup' AS tbl, 'recovered_from' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260410_create_ssg_issue_log.sql' AS file, 'TABLE' AS kind, 'ssg_issue_log' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260415_add_order_settled_amount_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'settled_amount_snapshot' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260422_create_giftiel_exchange_history.sql' AS file, 'TABLE' AS kind, 'giftiel_exchange_history' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260427_create_external_api_account.sql' AS file, 'TABLE' AS kind, 'external_api_account' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260427_create_external_api_account.sql' AS file, 'TABLE' AS kind, 'external_api_allowed_ip' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260427_create_external_api_account.sql' AS file, 'COLUMN' AS kind, 'product' AS tbl, 'is_cancelable' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260427_create_external_api_account.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'resend_count' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260427_create_external_api_ssg_request.sql' AS file, 'TABLE' AS kind, 'external_api_ssg_request' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260428_add_user_discount_indexes.sql' AS file, 'INDEX' AS kind, 'user_discount' AS tbl, 'idx_user_discount_user' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260428_add_user_discount_indexes.sql' AS file, 'INDEX' AS kind, 'user_discount' AS tbl, 'idx_user_discount_partner' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260428_extend_early_destroy_to_delivery.sql' AS file, 'INDEX' AS kind, 'early_destroy_request_item' AS tbl, 'idx_early_destroy_request_item_order_delivery_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260428_extend_early_destroy_to_delivery.sql' AS file, 'COLUMN' AS kind, 'early_destroy_request_item' AS tbl, 'order_delivery_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_person_name' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_person_phone' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_email' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_business_name' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_business_number' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_business_address' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_industry_type' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_industry_item' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_settle_condition' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_document_company_type' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_client_person_name' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_client_person_phone' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_client_email' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_client_business_name' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_client_business_number' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_client_business_address' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_client_industry_type' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_client_industry_item' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_client_settle_condition' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_client_document_company_type' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260430_add_order_user_snapshot.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'snapshot_operation_person_name' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260507_add_order_delivery_discarded_at.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'discarded_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260511_create_external_api_webhook.sql' AS file, 'TABLE' AS kind, 'external_api_webhook_log' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260511_create_external_api_webhook.sql' AS file, 'COLUMN' AS kind, 'external_api_account' AS tbl, 'cancel_webhook_url' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260511_create_external_api_webhook.sql' AS file, 'COLUMN' AS kind, 'external_api_account' AS tbl, 'cancel_webhook_enabled' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260512_add_order_delivery_refunded_at.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'refunded_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260512_create_order_delivery_refund.sql' AS file, 'TABLE' AS kind, 'order_delivery_refund' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260518_extend_ssg_issue_log_payload.sql' AS file, 'COLUMN' AS kind, 'ssg_issue_log' AS tbl, 'expire_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260518_extend_ssg_issue_log_payload.sql' AS file, 'COLUMN' AS kind, 'ssg_issue_log' AS tbl, 'encourage_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260518_extend_ssg_issue_log_payload.sql' AS file, 'COLUMN' AS kind, 'ssg_issue_log' AS tbl, 'coupon_num' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260519_add_ssg_balance_settled_to_refund_ledger.sql' AS file, 'COLUMN' AS kind, 'order_delivery_refund' AS tbl, 'ssg_balance_settled' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260519_create_order_delivery_ssg_insert_state.sql' AS file, 'TABLE' AS kind, 'order_delivery_ssg_insert_state' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260519_extend_ssg_issue_log_event_seq.sql' AS file, 'COLUMN' AS kind, 'ssg_issue_log' AS tbl, 'event_seq' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260519_extend_ssg_issue_log_event_seq.sql' AS file, 'COLUMN' AS kind, 'ssg_issue_log' AS tbl, 'ssg_event_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260519_extend_ssg_issue_log_event_seq.sql' AS file, 'INDEX' AS kind, 'ssg_issue_log' AS tbl, 'idx_ssg_issue_log_order_delivery_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260521_alter_user_add_settlement_code.sql' AS file, 'INDEX' AS kind, 'user' AS tbl, 'idx_user_settlement_code' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260521_alter_user_add_settlement_code.sql' AS file, 'COLUMN' AS kind, 'user' AS tbl, 'settlement_code' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260521_create_credit_excess_approval.sql' AS file, 'TABLE' AS kind, 'credit_excess_approval' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260521_create_order_delivery_attempt.sql' AS file, 'TABLE' AS kind, 'order_delivery_attempt' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260521_create_order_payment_allocation.sql' AS file, 'TABLE' AS kind, 'order_payment_allocation' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260521_create_order_payment_allocation.sql' AS file, 'TABLE' AS kind, 'order_payment_allocation_line' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260521_create_order_payment_refund_event.sql' AS file, 'TABLE' AS kind, 'order_payment_refund_event' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260521_create_point_tables.sql' AS file, 'TABLE' AS kind, 'point_grant' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260521_create_point_tables.sql' AS file, 'TABLE' AS kind, 'point_policy_rule' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260521_create_point_tables.sql' AS file, 'TABLE' AS kind, 'order_point_usage' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260521_create_wallet_tables.sql' AS file, 'TABLE' AS kind, 'wallet_account' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260521_create_wallet_tables.sql' AS file, 'TABLE' AS kind, 'wallet_transaction' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260523_alter_order_payment_allocation_add_released.sql' AS file, 'COLUMN' AS kind, 'order_payment_allocation' AS tbl, 'released_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260523_alter_order_payment_allocation_add_released.sql' AS file, 'COLUMN' AS kind, 'order_payment_allocation' AS tbl, 'release_reason' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260526_idx_galaxia_barcode_log_delivery_appdiv.sql' AS file, 'INDEX' AS kind, 'galaxia_barcode_log' AS tbl, 'idx_galaxia_barcode_log_delivery_appdiv' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260605_alter_user_login_lock.sql' AS file, 'COLUMN' AS kind, 'user' AS tbl, 'login_fail_count' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260605_alter_user_login_lock.sql' AS file, 'COLUMN' AS kind, 'user' AS tbl, 'is_login_locked' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260605_alter_user_login_lock.sql' AS file, 'COLUMN' AS kind, 'user' AS tbl, 'locked_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260608_create_forbidden_word.sql' AS file, 'TABLE' AS kind, 'forbidden_word' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260608_create_forbidden_word.sql' AS file, 'TABLE' AS kind, 'forbidden_word_history' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260608_create_forbidden_word.sql' AS file, 'TABLE' AS kind, 'forbidden_word_block_log' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260609_alter_user_dormant_columns.sql' AS file, 'COLUMN' AS kind, 'user' AS tbl, 'last_activity_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260609_alter_user_dormant_columns.sql' AS file, 'COLUMN' AS kind, 'user' AS tbl, 'suspended_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260609_alter_user_dormant_columns.sql' AS file, 'COLUMN' AS kind, 'user' AS tbl, 'withdrawn_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260609_alter_user_dormant_columns.sql' AS file, 'COLUMN' AS kind, 'user' AS tbl, 'anonymized_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260611_add_choice_reentry_block.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'choice_post_send_status' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260611_add_choice_reentry_block.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'choice_post_send_claim_token' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260611_add_choice_reentry_block.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'choice_post_send_claimed_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260611_add_choice_reentry_block.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'choice_post_sent_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260611_add_choice_reentry_block.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'choice_selection_claim_token' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260611_add_choice_reentry_block.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'choice_selection_claimed_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260611_add_choice_reentry_block.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'choice_selection_attempt_key' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260611_add_choice_reentry_block.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'choice_selection_reconcile_required_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260611_add_choice_reentry_block.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'email_coupon_claim_token' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260611_add_choice_reentry_block.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'email_coupon_claimed_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260611_add_choice_reentry_block.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'email_coupon_attempt_key' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260611_add_choice_reentry_block.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'email_coupon_reconcile_required_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260612_ssg_recovery_idempotency.sql' AS file, 'TABLE' AS kind, 'ssg_event_recovery_log' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260612_ssg_recovery_idempotency.sql' AS file, 'COLUMN' AS kind, 'order_delivery_refund' AS tbl, 'ssg_recover_token' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260612_ssg_recovery_idempotency.sql' AS file, 'COLUMN' AS kind, 'order_delivery_refund' AS tbl, 'ssg_recover_lease_until' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260612_ssg_recovery_idempotency.sql' AS file, 'COLUMN' AS kind, 'order_delivery_refund' AS tbl, 'ssg_recover_attempts' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260612_ssg_recovery_idempotency.sql' AS file, 'COLUMN' AS kind, 'order_delivery_refund' AS tbl, 'ssg_recover_escalated_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260612_ssg_recovery_sweep_index.sql' AS file, 'INDEX' AS kind, 'order_delivery_refund' AS tbl, 'idx_ssg_sweep' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260615_add_order_product_mapping_snapshot.sql' AS file, 'COLUMN' AS kind, 'order_product_mapping' AS tbl, 'snapshot_product_price' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260615_add_order_product_mapping_snapshot.sql' AS file, 'COLUMN' AS kind, 'order_product_mapping' AS tbl, 'snapshot_product_name' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260615_add_order_product_mapping_snapshot.sql' AS file, 'COLUMN' AS kind, 'order_product_mapping' AS tbl, 'snapshot_product_brand_name' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260615_add_order_product_mapping_snapshot.sql' AS file, 'COLUMN' AS kind, 'order_product_mapping' AS tbl, 'snapshot_product_expire_day' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260615_add_order_product_mapping_snapshot.sql' AS file, 'COLUMN' AS kind, 'order_product_mapping' AS tbl, 'snapshot_product_image_path' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260615_add_order_settle_method.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'settle_method' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260615_ssg_resend_deduct_recovery.sql' AS file, 'TABLE' AS kind, 'ssg_resend_deduct_recovery' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260616_add_order_history_discard_amounts.sql' AS file, 'COLUMN' AS kind, 'order_history' AS tbl, 'destroy_amount' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260616_add_order_history_discard_amounts.sql' AS file, 'COLUMN' AS kind, 'order_history' AS tbl, 'restore_amount' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260616_create_ssg_resend_deduct_pending.sql' AS file, 'TABLE' AS kind, 'ssg_resend_deduct_pending' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260617_add_product_ssg_price_unique.sql' AS file, 'COLUMN' AS kind, 'product' AS tbl, 'ssg_price_key' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260617_add_product_ssg_price_unique.sql' AS file, 'INDEX' AS kind, 'product' AS tbl, 'uq_product_ssg_price' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260618_add_user_hide_system_from_phone.sql' AS file, 'COLUMN' AS kind, 'user' AS tbl, 'hide_system_from_phone' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260619_pr2a_3layer_schema.sql' AS file, 'TABLE' AS kind, 'api_app' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260619_pr2a_3layer_schema.sql' AS file, 'TABLE' AS kind, 'api_credential' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260619_pr2a_3layer_schema.sql' AS file, 'INDEX' AS kind, 'idempotency_keys' AS tbl, 'uq_idempotency' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260619_pr2a_3layer_schema.sql' AS file, 'COLUMN' AS kind, 'external_api_allowed_ip' AS tbl, 'api_app_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260619_pr2a_3layer_schema.sql' AS file, 'INDEX' AS kind, 'external_api_allowed_ip' AS tbl, 'idx_external_api_allowed_ip_api_app' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260619_pr2a_3layer_schema.sql' AS file, 'COLUMN' AS kind, 'external_api_webhook_log' AS tbl, 'api_app_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260619_pr2a_3layer_schema.sql' AS file, 'INDEX' AS kind, 'external_api_webhook_log' AS tbl, 'idx_external_api_webhook_log_api_app' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260619_pr2a_3layer_schema.sql' AS file, 'COLUMN' AS kind, 'external_api_ssg_request' AS tbl, 'api_app_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260619_pr2a_3layer_schema.sql' AS file, 'INDEX' AS kind, 'external_api_ssg_request' AS tbl, 'idx_external_api_ssg_request_api_app' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260619_pr2a_3layer_schema.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'api_app_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260619_pr2a_3layer_schema.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'api_credential_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260619_pr2a_3layer_schema.sql' AS file, 'INDEX' AS kind, 'order' AS tbl, 'idx_order_api_app' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260619_pr2a_3layer_schema.sql' AS file, 'COLUMN' AS kind, 'idempotency_keys' AS tbl, 'api_app_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260622_pr2_customer_mapping.sql' AS file, 'TABLE' AS kind, 'api_customer_mapping' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260622_pr2_customer_mapping.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'external_order_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260622_pr2_customer_mapping.sql' AS file, 'COLUMN' AS kind, 'order' AS tbl, 'external_customer_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260622_pr2_customer_mapping.sql' AS file, 'INDEX' AS kind, 'order' AS tbl, 'uk_order_api_app_external_order' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260629_add_partner_settle_snapshot.sql' AS file, 'COLUMN' AS kind, 'order_product_mapping' AS tbl, 'partner_settle_price_adjustment' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260629_add_partner_settle_snapshot.sql' AS file, 'COLUMN' AS kind, 'order_product_mapping' AS tbl, 'partner_settle_fee' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260630_add_issue_outcome_to_ssg_resend_deduct_pending.sql' AS file, 'COLUMN' AS kind, 'ssg_resend_deduct_pending' AS tbl, 'issue_outcome' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260701_api_app_require_external_customer_id.sql' AS file, 'COLUMN' AS kind, 'api_app' AS tbl, 'require_external_customer_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260702_create_coupon_view_log.sql' AS file, 'TABLE' AS kind, 'coupon_view_log' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260707_add_api_app_require_external_order_id.sql' AS file, 'COLUMN' AS kind, 'api_app' AS tbl, 'require_external_order_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260715_add_wallet_transaction_operator_audit.sql' AS file, 'COLUMN' AS kind, 'wallet_transaction' AS tbl, 'balance_before' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260715_add_wallet_transaction_operator_audit.sql' AS file, 'COLUMN' AS kind, 'wallet_transaction' AS tbl, 'operator_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260715_add_wallet_transaction_operator_audit.sql' AS file, 'COLUMN' AS kind, 'wallet_transaction' AS tbl, 'operator_email' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260715_add_wallet_transaction_operator_audit.sql' AS file, 'INDEX' AS kind, 'wallet_transaction' AS tbl, 'idx_wallet_tx_operator' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260716_create_order_receipt_auto_order.sql' AS file, 'TABLE' AS kind, 'order_receipt_generated_order' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260716_create_order_receipt_auto_order.sql' AS file, 'TABLE' AS kind, 'order_receipt_auto_result' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260720_add_wallet_account_owner_company_id.sql' AS file, 'INDEX' AS kind, 'wallet_account' AS tbl, 'idx_wallet_account_owner_company' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260720_add_wallet_account_owner_company_id.sql' AS file, 'COLUMN' AS kind, 'wallet_account' AS tbl, 'owner_company_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260722_add_order_delivery_cancel_reason.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'canceled_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260722_add_order_delivery_cancel_reason.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'cancel_reason' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260727_add_order_delivery_actual_send_at_index.sql' AS file, 'INDEX' AS kind, 'order_delivery' AS tbl, 'idx_order_delivery_actual_send_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260727_create_delivery_tracking_workflow.sql' AS file, 'TABLE' AS kind, 'delivery_workflow' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260727_create_delivery_tracking_workflow.sql' AS file, 'TABLE' AS kind, 'pin_issue_command' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260727_create_delivery_tracking_workflow.sql' AS file, 'TABLE' AS kind, 'message_attempt' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260727_create_delivery_tracking_workflow.sql' AS file, 'TABLE' AS kind, 'refund_attempt' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260727_create_delivery_tracking_workflow.sql' AS file, 'TABLE' AS kind, 'dual_approval' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260727_create_delivery_tracking_workflow.sql' AS file, 'TABLE' AS kind, 'dual_approval_audit' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260727_create_delivery_tracking_workflow.sql' AS file, 'TABLE' AS kind, 'workflow_resolution' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260727_create_delivery_tracking_workflow.sql' AS file, 'TABLE' AS kind, 'stale_external_response' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260728_add_delivery_workflow_cutover_draining.sql' AS file, 'COLUMN' AS kind, 'delivery_workflow' AS tbl, 'cutover_draining_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260728_add_delivery_workflow_cutover_draining.sql' AS file, 'INDEX' AS kind, 'delivery_workflow' AS tbl, 'idx_delivery_workflow_draining' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260729_add_refund_attempt_entry_workflow_status.sql' AS file, 'COLUMN' AS kind, 'refund_attempt' AS tbl, 'entry_workflow_status' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260729_add_test_order_delivery_ops_escalated_at.sql' AS file, 'COLUMN' AS kind, 'test_order_delivery' AS tbl, 'ops_escalated_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260729_add_test_order_delivery_ops_escalated_at.sql' AS file, 'COLUMN' AS kind, 'test_order_delivery' AS tbl, 'limit_claimed' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260729_add_test_order_delivery_ops_escalated_at.sql' AS file, 'COLUMN' AS kind, 'test_order_delivery' AS tbl, 'confirmed_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260729_add_test_order_delivery_ops_escalated_at.sql' AS file, 'INDEX' AS kind, 'test_order_delivery' AS tbl, 'idx_test_order_delivery_mapping_status_created' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260729_bind_refund_attempt_to_ledger.sql' AS file, 'COLUMN' AS kind, 'order_delivery_refund' AS tbl, 'refund_attempt_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260729_bind_refund_attempt_to_ledger.sql' AS file, 'COLUMN' AS kind, 'order_delivery_refund' AS tbl, 'external_idempotency_key' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260729_bind_refund_attempt_to_ledger.sql' AS file, 'INDEX' AS kind, 'order_delivery_refund' AS tbl, 'uk_order_delivery_refund_attempt' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260729_bind_refund_attempt_to_ledger.sql' AS file, 'INDEX' AS kind, 'order_delivery_refund' AS tbl, 'uk_order_delivery_refund_external_idem' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260729_create_delivery_cancel_intent.sql' AS file, 'TABLE' AS kind, 'delivery_cancel_intent' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260803_add_refund_attempt_execution_quiesced.sql' AS file, 'COLUMN' AS kind, 'refund_attempt' AS tbl, 'execution_quiesced_generation' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260803_partner_credit_pr1a_discount_history.sql' AS file, 'TABLE' AS kind, 'partner_discount_scope' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260803_partner_credit_pr1a_discount_history.sql' AS file, 'TABLE' AS kind, 'partner_discount_policy_epoch' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260803_partner_credit_pr1a_discount_history.sql' AS file, 'TABLE' AS kind, 'partner_discount_history' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260803_partner_credit_pr1a_discount_history.sql' AS file, 'COLUMN' AS kind, 'order_product_mapping' AS tbl, 'snapshot_product_category' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260803_partner_credit_pr1a_discount_history.sql' AS file, 'COLUMN' AS kind, 'order_product_mapping' AS tbl, 'snapshot_product_classification_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260803_partner_credit_pr1a_discount_history.sql' AS file, 'CHECK' AS kind, 'user_discount' AS tbl, 'chk_user_discount_scope_xor' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260804_partner_credit_pr1b_ledger.sql' AS file, 'TABLE' AS kind, 'partner_provider_event_inbox' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260804_partner_credit_pr1b_ledger.sql' AS file, 'TABLE' AS kind, 'partner_settle_transition_observation' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260804_partner_credit_pr1b_ledger.sql' AS file, 'TABLE' AS kind, 'partner_settle_ledger' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260804_partner_credit_pr1b_ledger.sql' AS file, 'COLUMN' AS kind, 'galaxia_barcode_log' AS tbl, 'event_fingerprint' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260804_partner_credit_pr1b_ledger.sql' AS file, 'COLUMN' AS kind, 'galaxia_barcode_log' AS tbl, 'active_event_fingerprint' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260804_partner_credit_pr1b_ledger.sql' AS file, 'INDEX' AS kind, 'galaxia_barcode_log' AS tbl, 'uk_galaxia_barcode_log_active_event_fingerprint' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260804_ssg_issue_log_unique_keys.sql' AS file, 'INDEX' AS kind, 'ssg_issue_log' AS tbl, 'uq_ssg_issue_log_bar_code' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260804_ssg_issue_log_unique_keys.sql' AS file, 'INDEX' AS kind, 'ssg_issue_log' AS tbl, 'uq_ssg_issue_log_personal_code' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260805_partner_credit_pr2_config.sql' AS file, 'TABLE' AS kind, 'partner_credit_config' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260805_partner_credit_pr2_config.sql' AS file, 'TABLE' AS kind, 'partner_credit_config_history' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260806_partner_settle_pr1c_review.sql' AS file, 'TABLE' AS kind, 'partner_settle_review_resolution' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260806_partner_settle_pr1c_review.sql' AS file, 'TABLE' AS kind, 'partner_provider_manual_event_proposal' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260806_partner_settle_pr1c_review.sql' AS file, 'TABLE' AS kind, 'partner_provider_manual_ledger_proposal' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260806_partner_settle_pr1c_review.sql' AS file, 'TABLE' AS kind, 'partner_settle_review_audit' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260806_partner_settle_pr1c_review.sql' AS file, 'TABLE' AS kind, 'partner_settle_transition_resolution' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260806_partner_settle_pr1c_review.sql' AS file, 'COLUMN' AS kind, 'partner_settle_ledger' AS tbl, 'transition_allocation_no' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260806_partner_settle_pr1c_review.sql' AS file, 'INDEX' AS kind, 'partner_settle_ledger' AS tbl, 'uk_partner_settle_ledger_transition' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260806_partner_settle_pr1c_review.sql' AS file, 'CHECK' AS kind, 'partner_settle_ledger' AS tbl, 'chk_partner_settle_ledger_transition_pair' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260806_partner_settle_pr1c_review.sql' AS file, 'INDEX' AS kind, 'partner_settle_ledger' AS tbl, 'idx_ledger_review_resolution' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260806_partner_settle_pr1c_review.sql' AS file, 'INDEX' AS kind, 'partner_settle_ledger' AS tbl, 'idx_ledger_manual_ledger_proposal' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260806_partner_settle_pr1c_review.sql' AS file, 'FK' AS kind, 'partner_settle_ledger' AS tbl, 'fk_ledger_review_resolution' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260806_partner_settle_pr1c_review.sql' AS file, 'FK' AS kind, 'partner_settle_ledger' AS tbl, 'fk_ledger_manual_ledger_proposal' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260806_partner_settle_pr1c_review.sql' AS file, 'FK' AS kind, 'partner_provider_event_inbox' AS tbl, 'fk_inbox_manual_event_proposal' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260806_partner_settle_pr1c_review.sql' AS file, 'FK' AS kind, 'partner_provider_event_inbox' AS tbl, 'fk_inbox_manual_ledger_proposal' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260807_partner_settle_pr1d_confirm.sql' AS file, 'TABLE' AS kind, 'partner_settle_batch' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260807_partner_settle_pr1d_confirm.sql' AS file, 'TABLE' AS kind, 'partner_settle_batch_release_request' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260807_partner_settle_pr1d_confirm.sql' AS file, 'TABLE' AS kind, 'partner_settle_batch_release' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260807_partner_settle_pr1d_confirm.sql' AS file, 'TABLE' AS kind, 'partner_settle_exclusion' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260807_partner_settle_pr1d_confirm.sql' AS file, 'TABLE' AS kind, 'partner_settle_config' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260807_partner_settle_pr1d_confirm.sql' AS file, 'TABLE' AS kind, 'partner_settle_cancel_recon' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260807_partner_settle_pr1d_confirm.sql' AS file, 'TABLE' AS kind, 'partner_settle_payment_request' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260807_partner_settle_pr1d_confirm.sql' AS file, 'TABLE' AS kind, 'partner_settle_payment_variance_proposal' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260807_partner_settle_pr1d_confirm.sql' AS file, 'FK' AS kind, 'partner_settle_ledger' AS tbl, 'fk_ledger_settle_batch' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260807_partner_settle_pr1d_confirm.sql' AS file, 'FK' AS kind, 'partner_settle_batch' AS tbl, 'fk_batch_payment_request' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260807_partner_settle_pr3a_variance.sql' AS file, 'INDEX' AS kind, 'partner_settle_ledger' AS tbl, 'uk_partner_settle_ledger_payment_variance' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260807_partner_settle_pr3a_variance.sql' AS file, 'INDEX' AS kind, 'partner_settle_ledger' AS tbl, 'uk_partner_settle_ledger_variance_provenance' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260807_partner_settle_pr3a_variance.sql' AS file, 'FK' AS kind, 'partner_settle_ledger' AS tbl, 'fk_partner_settle_ledger_payment_variance' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260807_partner_settle_pr3a_variance.sql' AS file, 'CHECK' AS kind, 'partner_settle_ledger' AS tbl, 'chk_partner_settle_ledger_variance_shape' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260807_partner_settle_pr3a_variance.sql' AS file, 'CHECK' AS kind, 'partner_settle_ledger' AS tbl, 'chk_partner_settle_ledger_variance_sentinel' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260807_partner_settle_pr3a_variance.sql' AS file, 'FK' AS kind, 'partner_settle_payment_variance_proposal' AS tbl, 'fk_variance_result_ledger' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260807_partner_settle_pr3b_reservation.sql' AS file, 'TABLE' AS kind, 'partner_discount_reservation' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_add_pin_issue_command_p24_authority.sql' AS file, 'TABLE' AS kind, 'pin_issue_command_migration_marker' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_add_pin_issue_command_p24_authority.sql' AS file, 'COLUMN' AS kind, 'pin_issue_command' AS tbl, 'external_issue_count' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_add_pin_issue_command_p24_authority.sql' AS file, 'COLUMN' AS kind, 'pin_issue_command' AS tbl, 'resolution' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_add_pin_issue_command_p24_authority.sql' AS file, 'COLUMN' AS kind, 'pin_issue_command' AS tbl, 'resolution_lookup_count' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_add_pin_issue_command_p24_authority.sql' AS file, 'COLUMN' AS kind, 'pin_issue_command' AS tbl, 'resolution_started_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_add_pin_issue_command_p24_authority.sql' AS file, 'COLUMN' AS kind, 'pin_issue_command' AS tbl, 'lease_expires_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_add_pin_issue_command_p24_authority.sql' AS file, 'COLUMN' AS kind, 'pin_issue_command' AS tbl, 'owner_token' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_add_pin_issue_command_p24_authority.sql' AS file, 'COLUMN' AS kind, 'pin_issue_command' AS tbl, 'delivery_claim_token' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_add_pin_issue_command_p24_authority.sql' AS file, 'COLUMN' AS kind, 'pin_issue_command' AS tbl, 'generation' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_add_pin_issue_command_p24_authority.sql' AS file, 'COLUMN' AS kind, 'pin_issue_command' AS tbl, 'workflow_version' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_add_pin_issue_command_p24_authority.sql' AS file, 'COLUMN' AS kind, 'pin_issue_command' AS tbl, 'active_order_delivery_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_add_pin_issue_command_p24_authority.sql' AS file, 'INDEX' AS kind, 'pin_issue_command' AS tbl, 'uk_pin_issue_command_active_delivery' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_partner_settle_pr3c_adjustment_proposal.sql' AS file, 'TABLE' AS kind, 'partner_settle_adjustment_proposal' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_partner_settle_pr3c_adjustment_proposal.sql' AS file, 'INDEX' AS kind, 'partner_settle_adjustment_proposal' AS tbl, 'idx_adj_proposal_partner' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_partner_settle_pr3c_adjustment_proposal.sql' AS file, 'INDEX' AS kind, 'partner_settle_adjustment_proposal' AS tbl, 'idx_adj_proposal_group' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_partner_settle_pr3c_adjustment_proposal.sql' AS file, 'INDEX' AS kind, 'partner_settle_adjustment_proposal' AS tbl, 'idx_adj_proposal_source' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_partner_settle_pr3c_adjustment_proposal.sql' AS file, 'INDEX' AS kind, 'partner_settle_adjustment_proposal' AS tbl, 'idx_adj_proposal_cursor' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_partner_settle_pr3c_adjustment_proposal.sql' AS file, 'COLUMN' AS kind, 'partner_settle_ledger' AS tbl, 'adjustment_proposal_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_partner_settle_pr3c_adjustment_proposal.sql' AS file, 'INDEX' AS kind, 'partner_settle_ledger' AS tbl, 'uk_ledger_adj_proposal' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_partner_settle_pr3c_adjustment_proposal.sql' AS file, 'INDEX' AS kind, 'partner_settle_ledger' AS tbl, 'uk_ledger_id_partner' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_partner_settle_pr3c_adjustment_proposal.sql' AS file, 'INDEX' AS kind, 'partner_settle_ledger' AS tbl, 'uk_ledger_adj_proposal_partner' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_partner_settle_pr3c_adjustment_proposal.sql' AS file, 'INDEX' AS kind, 'partner_discount_history' AS tbl, 'uk_partner_discount_history_id_partner' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_partner_settle_pr3c_adjustment_proposal.sql' AS file, 'FK' AS kind, 'partner_settle_adjustment_proposal' AS tbl, 'fk_adj_proposal_result' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_partner_settle_pr3c_adjustment_proposal.sql' AS file, 'FK' AS kind, 'partner_settle_ledger' AS tbl, 'fk_ledger_adj_proposal' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_partner_settle_pr3c_adjustment_proposal.sql' AS file, 'CHECK' AS kind, 'partner_settle_ledger' AS tbl, 'chk_partner_settle_ledger_adj_shape' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260810_partner_settle_pr3c_adjustment_proposal.sql' AS file, 'CHECK' AS kind, 'partner_settle_ledger' AS tbl, 'chk_ledger_adj_exclusive' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260811_add_qna_author_snapshot.sql' AS file, 'COLUMN' AS kind, 'qna' AS tbl, 'snapshot_person_name' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260811_add_qna_author_snapshot.sql' AS file, 'COLUMN' AS kind, 'qna' AS tbl, 'snapshot_business_name' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260812_add_order_receipt_person_snapshot.sql' AS file, 'COLUMN' AS kind, 'order_receipt' AS tbl, 'snapshot_person_name' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260812_add_order_receipt_person_snapshot.sql' AS file, 'COLUMN' AS kind, 'order_receipt' AS tbl, 'snapshot_business_name' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260812_add_order_receipt_person_snapshot.sql' AS file, 'COLUMN' AS kind, 'order_receipt' AS tbl, 'snapshot_processed_person_name' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260814_ssg_pin_autoresolve_p30_p0.sql' AS file, 'TABLE' AS kind, 'ssg_pin_observation_run' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260814_ssg_pin_autoresolve_p30_p0.sql' AS file, 'TABLE' AS kind, 'ssg_pin_observation_candidate' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260814_ssg_pin_autoresolve_p30_p0.sql' AS file, 'COLUMN' AS kind, 'ssg_issue_log' AS tbl, 'pin_issue_command_id' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260814_ssg_pin_autoresolve_p30_p0.sql' AS file, 'COLUMN' AS kind, 'ssg_issue_log' AS tbl, 'issue_ordinal' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260814_ssg_pin_autoresolve_p30_p0.sql' AS file, 'COLUMN' AS kind, 'ssg_issue_log' AS tbl, 'superseded_at' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260814_ssg_pin_autoresolve_p30_p0.sql' AS file, 'INDEX' AS kind, 'ssg_issue_log' AS tbl, 'idx_ssg_issue_log_delivery_active' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260814_ssg_pin_autoresolve_p30_p0.sql' AS file, 'COLUMN' AS kind, 'pin_issue_command' AS tbl, 'autoresolve_version' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260818_ssg_pin_autoresolve_p30_p1.sql' AS file, 'TABLE' AS kind, 'ssg_issue_log_ops_archive' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'sql/migrations/20260818_ssg_pin_autoresolve_p30_p1.sql' AS file, 'INDEX' AS kind, 'ssg_issue_log' AS tbl, 'uq_ssg_issue_log_cmd_ordinal' AS obj
  UNION ALL
  SELECT 'sql/migrations/20260818_ssg_pin_autoresolve_p30_p1.sql' AS file, 'CHECK' AS kind, 'ssg_issue_log' AS tbl, 'ck_ssg_issue_log_ordinal' AS obj
  UNION ALL
  SELECT 'migration/alimtalk-async-report.sql' AS file, 'INDEX' AS kind, 'order_delivery' AS tbl, 'idx_od_report_sweep' AS obj
  UNION ALL
  SELECT 'migration/alimtalk-async-report.sql' AS file, 'INDEX' AS kind, 'delivery_send_history' AS tbl, 'idx_dsh_order_delivery_id' AS obj
  UNION ALL
  SELECT 'migration/alimtalk-async-report.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'alim_talk_msg_key' AS obj
  UNION ALL
  SELECT 'migration/alimtalk-async-report.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'report_state' AS obj
  UNION ALL
  SELECT 'migration/alimtalk-async-report.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'report_deadline_at' AS obj
  UNION ALL
  SELECT 'migration/alimtalk-async-report.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'report_attempt_count' AS obj
  UNION ALL
  SELECT 'migration/alimtalk-async-report.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'report_fallback_attempt_count' AS obj
  UNION ALL
  SELECT 'migration/alimtalk-async-report.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'report_next_due_at' AS obj
  UNION ALL
  SELECT 'migration/alimtalk-async-report.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'report_claimed_at' AS obj
  UNION ALL
  SELECT 'migration/alimtalk-async-report.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'report_owner_token' AS obj
  UNION ALL
  SELECT 'migration/alimtalk-async-report.sql' AS file, 'COLUMN' AS kind, 'delivery_send_history' AS tbl, 'order_delivery_id' AS obj
  UNION ALL
  SELECT 'migration/bank-deposit-mirror.sql' AS file, 'TABLE' AS kind, 'bank_deposit' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'migration/card-surcharge-toggle.sql' AS file, 'COLUMN' AS kind, 'wallet_account' AS tbl, 'card_surcharge_applied' AS obj
  UNION ALL
  SELECT 'migration/credit-excess-approval-dispatch.sql' AS file, 'TABLE' AS kind, 'credit_excess_approval_execution' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'migration/credit-excess-approval-dispatch.sql' AS file, 'COLUMN' AS kind, 'credit_excess_approval' AS tbl, 'attempt_token' AS obj
  UNION ALL
  SELECT 'migration/credit-excess-approval-dispatch.sql' AS file, 'COLUMN' AS kind, 'credit_excess_approval' AS tbl, 'attempt_count' AS obj
  UNION ALL
  SELECT 'migration/credit-excess-approval-dispatch.sql' AS file, 'COLUMN' AS kind, 'credit_excess_approval' AS tbl, 'lease_expires_at' AS obj
  UNION ALL
  SELECT 'migration/credit-excess-approval-dispatch.sql' AS file, 'COLUMN' AS kind, 'credit_excess_approval' AS tbl, 'processing_started_at' AS obj
  UNION ALL
  SELECT 'migration/credit-excess-approval-dispatch.sql' AS file, 'COLUMN' AS kind, 'credit_excess_approval' AS tbl, 'finished_at' AS obj
  UNION ALL
  SELECT 'migration/credit-excess-approval-dispatch.sql' AS file, 'COLUMN' AS kind, 'credit_excess_approval' AS tbl, 'diagnostic_code' AS obj
  UNION ALL
  SELECT 'migration/credit-excess-approval-dispatch.sql' AS file, 'COLUMN' AS kind, 'credit_excess_approval' AS tbl, 'user_message' AS obj
  UNION ALL
  SELECT 'migration/credit-excess-approval-dispatch.sql' AS file, 'COLUMN' AS kind, 'credit_excess_approval' AS tbl, 'changed_fields' AS obj
  UNION ALL
  SELECT 'migration/credit-excess-approval-dispatch.sql' AS file, 'COLUMN' AS kind, 'credit_excess_approval' AS tbl, 'internal_reason' AS obj
  UNION ALL
  SELECT 'migration/credit-excess-approval-dispatch.sql' AS file, 'COLUMN' AS kind, 'credit_excess_approval' AS tbl, 'snapshot_version' AS obj
  UNION ALL
  SELECT 'migration/credit-excess-approval-dispatch.sql' AS file, 'COLUMN' AS kind, 'credit_excess_approval' AS tbl, 'snapshot' AS obj
  UNION ALL
  SELECT 'migration/credit-excess-approval-dispatch.sql' AS file, 'COLUMN' AS kind, 'credit_excess_approval' AS tbl, 'active_order_key' AS obj
  UNION ALL
  SELECT 'migration/credit-excess-approval-dispatch.sql' AS file, 'INDEX' AS kind, 'credit_excess_approval' AS tbl, 'uq_credit_excess_active_order' AS obj
  UNION ALL
  SELECT 'migration/credit-excess-approval-dispatch.sql' AS file, 'INDEX' AS kind, 'credit_excess_approval' AS tbl, 'idx_credit_excess_lease' AS obj
  UNION ALL
  SELECT 'migration/email-final-send-method.sql' AS file, 'COLUMN' AS kind, 'order_product_mapping' AS tbl, 'email_final_send_method' AS obj
  UNION ALL
  SELECT 'migration/external-api-migration.sql' AS file, 'TABLE' AS kind, 'idempotency_keys' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'migration/external-api-migration.sql' AS file, 'INDEX' AS kind, 'order_delivery' AS tbl, 'idx_order_delivery_external_tr_id' AS obj
  UNION ALL
  SELECT 'migration/external-api-migration.sql' AS file, 'COLUMN' AS kind, 'user' AS tbl, 'api_key_hash' AS obj
  UNION ALL
  SELECT 'migration/external-api-migration.sql' AS file, 'INDEX' AS kind, 'order' AS tbl, 'idx_order_type' AS obj
  UNION ALL
  SELECT 'migration/external-api-migration.sql' AS file, 'INDEX' AS kind, 'order_delivery' AS tbl, 'idx_order_delivery_transaction_id' AS obj
  UNION ALL
  SELECT 'migration/from-phone-sot.sql' AS file, 'INDEX' AS kind, 'order_from_definition' AS tbl, 'uq_order_from_active' AS obj
  UNION ALL
  SELECT 'migration/from-phone-sot.sql' AS file, 'INDEX' AS kind, 'order_from_definition' AS tbl, 'idx_order_from_lookup' AS obj
  UNION ALL
  SELECT 'migration/from-phone-sot.sql' AS file, 'COLUMN' AS kind, 'order_from_definition' AS tbl, 'active_from_key' AS obj
  UNION ALL
  SELECT 'migration/mutation-claim-lease.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'mutation_claimed_at' AS obj
  UNION ALL
  SELECT 'migration/order-delivery-destroyed-at.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'destroyed_at' AS obj
  UNION ALL
  SELECT 'migration/order-delivery-destroyed-at.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'destroyed_at_source' AS obj
  UNION ALL
  SELECT 'migration/order-delivery-memo.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'memo' AS obj
  UNION ALL
  SELECT 'migration/order-delivery-memo.sql' AS file, 'COLUMN' AS kind, 'order_manual_entry' AS tbl, 'memo' AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'TABLE' AS kind, 'inventory_coupon_product_config' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'TABLE' AS kind, 'inventory_pin_import_batch' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'TABLE' AS kind, 'inventory_pin_import_error' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'TABLE' AS kind, 'inventory_pin_item' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'TABLE' AS kind, 'inventory_pin_email_attempt' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'TABLE' AS kind, 'inventory_pin_email_outbox' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'TABLE' AS kind, 'inventory_pin_billing_chain' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'TABLE' AS kind, 'inventory_pin_reissue' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'TABLE' AS kind, 'pin_inventory_policy' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'TABLE' AS kind, 'direct_pin_delivery_policy' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'TABLE' AS kind, 'external_api_pin_inventory_request' AS tbl, NULL AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'direct_pin_fulfillment_status' AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'inventory_pin_billing_chain_id' AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'delivery_target_version' AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'direct_pin_latest_attempt_id' AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'direct_pin_sent_at' AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'COLUMN' AS kind, 'order_delivery' AS tbl, 'external_request_hash' AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'COLUMN' AS kind, 'order_product_mapping' AS tbl, 'direct_pin_email_snapshot' AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'COLUMN' AS kind, 'api_app' AS tbl, 'pin_inventory_enabled' AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'COLUMN' AS kind, 'order_delivery_refund' AS tbl, 'inventory_pin_billing_chain_id' AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'INDEX' AS kind, 'order_delivery_refund' AS tbl, 'uk_order_delivery_refund_billing_chain' AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'COLUMN' AS kind, 'inventory_coupon_product_config' AS tbl, 'validity_days' AS obj
  UNION ALL
  SELECT 'migration/overseas-pin-inventory.sql' AS file, 'COLUMN' AS kind, 'inventory_coupon_product_config' AS tbl, 'validity_starts_next_day' AS obj
  UNION ALL
  SELECT 'migration/ssg-product-memo-notice-sync.sql' AS file, 'TABLE' AS kind, 'product_memo_backup_ssg_20260812' AS tbl, NULL AS obj
)
SELECT e.file, e.kind, e.tbl, e.obj,
       CASE
         WHEN e.kind = 'TABLE' THEN
           IF(EXISTS (SELECT 1 FROM information_schema.TABLES t
                       WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME = e.tbl), 'ok', 'MISSING')
         WHEN e.kind = 'COLUMN' THEN
           IF(EXISTS (SELECT 1 FROM information_schema.COLUMNS c
                       WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = e.tbl AND c.COLUMN_NAME = e.obj),
              'ok', 'MISSING')
         WHEN e.kind = 'INDEX' THEN
           IF(EXISTS (SELECT 1 FROM information_schema.STATISTICS s
                       WHERE s.TABLE_SCHEMA = DATABASE() AND s.TABLE_NAME = e.tbl AND s.INDEX_NAME = e.obj),
              'ok', 'MISSING')
         ELSE
           IF(EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS tc
                       WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = e.tbl
                         AND tc.CONSTRAINT_NAME = e.obj), 'ok', 'MISSING')
       END AS status
  FROM expected e
 ORDER BY status DESC, e.file, e.kind, e.tbl, e.obj;
