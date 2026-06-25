TABLE_NAME COLUMN_NAME COLUMN_TYPE IS_NULLABLE COLUMN_KEY COLUMN_DEFAULT EXTRA
\_bak_all_settle_20260601 id int NO 0
\_bak_all_settle_20260601 old_amount int YES 0
\_bak_all_settle_20260601 backed_up_at datetime(6) NO [NULL]
activity_log id int NO PRI [NULL] auto_increment
activity_log user_id int NO MUL [NULL]
activity_log user_email varchar(100) NO MUL [NULL]
activity_log method varchar(10) NO [NULL]
activity_log request_url varchar(500) NO [NULL]
activity_log action_type varchar(100) NO MUL [NULL]
activity_log ip_address varchar(50) NO [NULL]
activity_log user_agent varchar(500) YES [NULL]
activity_log status_code int NO [NULL]
activity_log result varchar(1) NO MUL [NULL]
activity_log response_time int NO 0
activity_log download_reason text YES [NULL]
activity_log record_count int YES [NULL]
activity_log request_params json YES [NULL]
activity_log error_message text YES [NULL]
activity_log created_at datetime(6) NO MUL CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
activity_log updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
activity_log deleted_at datetime(6) YES [NULL]
api_app id bigint NO PRI [NULL] auto_increment
api_app default_billing_user_id int NO MUL [NULL]
api_app source_account_id bigint YES UNI [NULL]
api_app name varchar(100) YES [NULL]
api_app is_active tinyint(1) NO 1
api_app ssg_enabled tinyint(1) NO 0
api_app resend_max_count int YES [NULL]
api_app cancel_webhook_url varchar(512) YES [NULL]
api_app cancel_webhook_enabled tinyint(1) NO 0
api_app created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
api_app updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
api_app deleted_at datetime(6) YES [NULL]
api_credential id bigint NO PRI [NULL] auto_increment
api_credential api_app_id bigint NO MUL [NULL]
api_credential api_key_hash varchar(64) NO UNI [NULL]
api_credential is_active tinyint(1) NO 1
api_credential issued_at datetime NO [NULL]
api_credential revoked_at datetime YES [NULL]
api_credential created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
api_credential updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
api_credential deleted_at datetime(6) YES [NULL]
brand created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
brand updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
brand deleted_at datetime(6) YES [NULL]
brand id int NO PRI [NULL] auto_increment
brand code varchar(20) NO UNI [NULL]
brand name_korean varchar(200) NO [NULL]
brand name_english varchar(200) NO [NULL]
brand is_used tinyint NO [NULL]
classification id int NO PRI [NULL] auto_increment
classification classification varchar(100) NO [NULL]
classification created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
classification updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
classification deleted_at datetime(6) YES [NULL]
credit_excess_approval id bigint NO PRI [NULL] auto_increment
credit_excess_approval order_id int NO MUL [NULL]
credit_excess_approval wallet_account_id bigint NO [NULL]
credit_excess_approval requested_amount int NO [NULL]
credit_excess_approval requested_credit_excess_amount int NO [NULL]
credit_excess_approval reason_text varchar(200) NO [NULL]
credit_excess_approval requested_by int NO [NULL]
credit_excess_approval requested_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
credit_excess_approval status varchar(20) NO MUL PENDING
credit_excess_approval approved_by int YES [NULL]
credit_excess_approval approved_at datetime(6) YES [NULL]
credit_excess_approval reject_reason varchar(200) YES [NULL]
credit_excess_approval consumed_at datetime(6) YES [NULL]
delivery_send_history created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
delivery_send_history updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
delivery_send_history deleted_at datetime(6) YES [NULL]
delivery_send_history id int NO PRI [NULL] auto_increment
delivery_send_history target varchar(255) NO [NULL]
delivery_send_history context text NO [NULL]
delivery_send_history is_success tinyint NO [NULL]
delivery_send_history delivery_method varchar(255) NO [NULL]
delivery_send_history etc_context text YES [NULL]
department id int NO PRI [NULL] auto_increment
department company_id bigint NO MUL [NULL]
department name varchar(100) NO [NULL]
department created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
department updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
department deleted_at datetime(6) YES [NULL]
early_destroy_request id bigint NO PRI [NULL] auto_increment
early_destroy_request order_id bigint NO MUL [NULL]
early_destroy_request client_company varchar(100) YES [NULL]
early_destroy_request contact_person varchar(100) YES [NULL]
early_destroy_request contact_email varchar(200) YES [NULL]
early_destroy_request sales_receipt varchar(100) YES [NULL]
early_destroy_request event_name varchar(200) YES [NULL]
early_destroy_request product_info varchar(200) YES [NULL]
early_destroy_request special_notes text YES [NULL]
early_destroy_request desired_completion_date datetime YES [NULL]
early_destroy_request reference_notes text YES [NULL]
early_destroy_request status enum('PENDING','COMPLETED','CANCELLED') NO MUL PENDING
early_destroy_request requested_by bigint NO [NULL]
early_destroy_request requested_at datetime NO [NULL]
early_destroy_request executed_by bigint YES [NULL]
early_destroy_request executed_at datetime YES [NULL]
early_destroy_request created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
early_destroy_request updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
early_destroy_request deleted_at datetime(6) YES [NULL]
early_destroy_request_item id bigint NO PRI [NULL] auto_increment
early_destroy_request_item early_destroy_request_id bigint NO MUL [NULL]
early_destroy_request_item order_product_mapping_id bigint NO MUL [NULL]
early_destroy_request_item order_delivery_id bigint YES MUL [NULL]
early_destroy_request_item created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
early_destroy_request_item updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
early_destroy_request_item deleted_at datetime(6) YES [NULL]
email_manual id int NO PRI [NULL] auto_increment
email_manual content text NO [NULL]
email_manual user_id int NO MUL [NULL]
email_manual created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
email_manual updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
email_manual deleted_at datetime(6) YES [NULL]
email_send_history id int NO PRI [NULL] auto_increment
email_send_history email varchar(512) NO MUL [NULL]
email_send_history type enum('LOGIN','PASSWORD','COUPON','REACTIVATE') NO [NULL]
email_send_history code varchar(255) YES [NULL]
email_send_history is_certified tinyint NO 0
email_send_history expire_at datetime NO [NULL]
email_send_history created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
email_send_history updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
email_send_history deleted_at datetime(6) YES [NULL]
email_send_history order_delivery_id int YES MUL [NULL]
email_send_history user_id int YES MUL [NULL]
event created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
event updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
event deleted_at datetime(6) YES [NULL]
event id int NO PRI [NULL] auto_increment
event code varchar(20) NO [NULL]
event name varchar(20) NO [NULL]
event end_at datetime NO [NULL]
event_product_mapping created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
event_product_mapping updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
event_product_mapping deleted_at datetime(6) YES [NULL]
event_product_mapping id int NO PRI [NULL] auto_increment
event_product_mapping event_id int NO MUL [NULL]
event_product_mapping product_id int NO MUL [NULL]
external_api_account id bigint NO PRI [NULL] auto_increment
external_api_account user_id int NO UNI [NULL]
external_api_account api_key_hash varchar(64) NO UNI [NULL]
external_api_account is_active tinyint(1) NO MUL 1
external_api_account ssg_enabled tinyint(1) NO 0
external_api_account resend_max_count int YES [NULL]
external_api_account cancel_webhook_url varchar(512) YES [NULL]
external_api_account cancel_webhook_enabled tinyint(1) NO 0
external_api_account created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
external_api_account updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
external_api_account deleted_at datetime(6) YES [NULL]
external_api_allowed_ip id bigint NO PRI [NULL] auto_increment
external_api_allowed_ip account_id bigint NO MUL [NULL]
external_api_allowed_ip api_app_id bigint YES MUL [NULL]
external_api_allowed_ip ip_address varchar(45) NO [NULL]
external_api_allowed_ip description varchar(100) YES [NULL]
external_api_allowed_ip created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
external_api_ssg_request id bigint NO PRI [NULL] auto_increment
external_api_ssg_request account_id bigint NO MUL [NULL]
external_api_ssg_request api_app_id bigint YES MUL [NULL]
external_api_ssg_request requested_by_user_id int NO [NULL]
external_api_ssg_request reason varchar(500) NO [NULL]
external_api_ssg_request status enum('PENDING','APPROVED','REJECTED','CANCELLED') NO MUL PENDING
external_api_ssg_request decided_by_user_id int YES [NULL]
external_api_ssg_request decided_at datetime(6) YES [NULL]
external_api_ssg_request decision_note varchar(500) YES [NULL]
external_api_ssg_request created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
external_api_ssg_request updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
external_api_webhook_log id bigint NO PRI [NULL] auto_increment
external_api_webhook_log external_api_account_id bigint NO MUL [NULL]
external_api_webhook_log order_delivery_id bigint YES MUL [NULL]
external_api_webhook_log event_type varchar(32) NO [NULL]
external_api_webhook_log event_id varchar(64) NO MUL [NULL]
external_api_webhook_log request_url varchar(512) NO [NULL]
external_api_webhook_log request_body text NO [NULL]
external_api_webhook_log response_status int YES [NULL]
external_api_webhook_log response_body text YES [NULL]
external_api_webhook_log error_message text YES [NULL]
external_api_webhook_log is_success tinyint(1) NO [NULL]
external_api_webhook_log response_time_ms int YES [NULL]
external_api_webhook_log created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
forbidden_word id int NO PRI [NULL] auto_increment
forbidden_word word varchar(100) NO UNI [NULL]
forbidden_word category varchar(50) YES MUL [NULL]
forbidden_word is_active tinyint(1) NO MUL 1
forbidden_word created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
forbidden_word updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
forbidden_word deleted_at datetime(6) YES [NULL]
forbidden_word_block_log id int NO PRI [NULL] auto_increment
forbidden_word_block_log user_id int NO MUL [NULL]
forbidden_word_block_log user_email varchar(100) NO MUL [NULL]
forbidden_word_block_log matched_words json NO [NULL]
forbidden_word_block_log field varchar(50) NO [NULL]
forbidden_word_block_log content_snippet varchar(500) NO [NULL]
forbidden_word_block_log order_id int YES [NULL]
forbidden_word_block_log created_at datetime(6) NO MUL CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
forbidden_word_history id int NO PRI [NULL] auto_increment
forbidden_word_history word varchar(100) NO MUL [NULL]
forbidden_word_history action varchar(10) NO [NULL]
forbidden_word_history reason varchar(500) YES [NULL]
forbidden_word_history changed_by_user_id int NO [NULL]
forbidden_word_history changed_by_email varchar(100) NO MUL [NULL]
forbidden_word_history created_at datetime(6) NO MUL CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
galaxia_barcode_log id int NO PRI [NULL] auto_increment
galaxia_barcode_log order_delivery_id int NO [NULL]
galaxia_barcode_log barcode varchar(256) NO MUL [NULL]
galaxia_barcode_log app_div varchar(10) NO [NULL]
galaxia_barcode_log app_day varchar(8) NO MUL [NULL]
galaxia_barcode_log app_time varchar(6) NO [NULL]
galaxia_barcode_log amount int NO [NULL]
galaxia_barcode_log app_no varchar(100) YES [NULL]
galaxia_barcode_log app_store varchar(200) YES [NULL]
galaxia_barcode_log gift_kind varchar(10) NO [NULL]
galaxia_barcode_log created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
galaxia_barcode_log updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
galaxia_barcode_log deleted_at datetime(6) YES [NULL]
idempotency_keys id int NO PRI [NULL] auto_increment
idempotency_keys idempotency_key varchar(64) NO MUL [NULL]
idempotency_keys user_id int NO [NULL]
idempotency_keys api_app_id bigint YES [NULL]
idempotency_keys endpoint varchar(200) NO [NULL]
idempotency_keys request_hash varchar(64) NO [NULL]
idempotency_keys status enum('PROCESSING','COMPLETE') NO PROCESSING
idempotency_keys response_body json YES [NULL]
idempotency_keys response_status int YES [NULL]
idempotency_keys created_at datetime NO CURRENT_TIMESTAMP DEFAULT_GENERATED
idempotency_keys expires_at datetime NO MUL [NULL]
inquiry created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
inquiry updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
inquiry deleted_at datetime(6) YES [NULL]
inquiry id int NO PRI [NULL] auto_increment
inquiry user_id int NO MUL [NULL]
inquiry status varchar(50) NO [NULL]
inquiry file_path text YES [NULL]
inquiry title varchar(50) NO [NULL]
inquiry content varchar(200) NO [NULL]
inquiry reply_content varchar(200) YES [NULL]
message_archive created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
message_archive updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
message_archive deleted_at datetime(6) YES [NULL]
message_archive id int NO PRI [NULL] auto_increment
message_archive user_id int NO [NULL]
message_archive title varchar(20) NO [NULL]
message_archive content varchar(200) NO [NULL]
notice created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
notice updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
notice deleted_at datetime(6) YES [NULL]
notice id int NO PRI [NULL] auto_increment
notice user_id int NO [NULL]
notice title varchar(50) NO [NULL]
notice content varchar(15000) YES [NULL]
notice priority varchar(100) NO [NULL]
notice register_at datetime NO [NULL]
notice file_path text YES [NULL]
order id int NO PRI [NULL] auto_increment
order user_id int NO MUL [NULL]
order status varchar(255) NO MUL [NULL]
order type varchar(255) NO MUL [NULL]
order event_name varchar(100) NO [NULL]
order send_title varchar(20) NO [NULL]
order register_at datetime NO [NULL]
order send_amount int NO 0
order settle_amount int NO 0
order settled_amount_snapshot int YES [NULL]
order created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
order updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
order deleted_at datetime(6) YES [NULL]
order operation_user_id int YES [NULL]
order code varchar(256) YES UNI [NULL]
order delivery_complete_report_count int NO 0
order order_complete_report_count int NO 0
order SSG_EVENT_ID int YES [NULL]
order settle_status enum('UNSETTLE_OVERDUE','UNSETTLE_NORMAL','SETTLE_COMPLETE') YES [NULL]
order is_settle_complete tinyint(1) YES 0
order is_settle_balance tinyint(1) YES 0
order is_new_billing_flow tinyint(1) NO 1
order api_app_id bigint YES MUL [NULL]
order api_credential_id bigint YES [NULL]
order external_order_id varchar(191) YES [NULL]
order external_customer_id varchar(191) YES [NULL]
order card_surcharge_applied tinyint(1) NO 0
order settle_method enum('CARD','CASH') YES [NULL]
order is_credit_excess tinyint(1) NO 0
order delivery_report_last_source varchar(20) YES [NULL]
order transaction_statement_last_source varchar(20) YES [NULL]
order cancel_reason text YES [NULL]
order canceled_at datetime YES [NULL]
order client_user_id int YES MUL [NULL]
order snapshot_person_name varchar(100) YES [NULL]
order snapshot_person_phone varchar(20) YES [NULL]
order snapshot_email varchar(100) YES [NULL]
order snapshot_business_name varchar(100) YES [NULL]
order snapshot_business_number varchar(100) YES [NULL]
order snapshot_business_address varchar(255) YES [NULL]
order snapshot_industry_type varchar(100) YES [NULL]
order snapshot_industry_item varchar(100) YES [NULL]
order snapshot_settle_condition varchar(20) YES [NULL]
order snapshot_document_company_type varchar(20) YES [NULL]
order snapshot_client_person_name varchar(100) YES [NULL]
order snapshot_client_person_phone varchar(20) YES [NULL]
order snapshot_client_email varchar(100) YES [NULL]
order snapshot_client_business_name varchar(100) YES [NULL]
order snapshot_client_business_number varchar(100) YES [NULL]
order snapshot_client_business_address varchar(255) YES [NULL]
order snapshot_client_industry_type varchar(100) YES [NULL]
order snapshot_client_industry_item varchar(100) YES [NULL]
order snapshot_client_settle_condition varchar(20) YES [NULL]
order snapshot_client_document_company_type varchar(20) YES [NULL]
order snapshot_operation_person_name varchar(100) YES [NULL]
order_delivery created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
order_delivery updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
order_delivery deleted_at datetime(6) YES [NULL]
order_delivery id int NO PRI [NULL] auto_increment
order_delivery order_product_mapping_id int NO MUL [NULL]
order_delivery delivery_method varchar(255) NO [NULL]
order_delivery delivery_target varchar(128) NO [NULL]
order_delivery image_path varchar(512) YES [NULL]
order_delivery replace_character1 varchar(200) YES [NULL]
order_delivery replace_character2 varchar(200) YES [NULL]
order_delivery replace_character3 varchar(200) YES [NULL]
order_delivery send_request_at datetime NO [NULL]
order_delivery status varchar(255) NO [NULL]
order_delivery bar_code varchar(256) YES [NULL]
order_delivery transaction_id varchar(256) YES UNI [NULL]
order_delivery external_tr_id varchar(26) YES UNI [NULL]
order_delivery personal_code varchar(100) YES [NULL]
order_delivery ssg_event_id int YES [NULL]
order_delivery email_coupon_status varchar(100) YES [NULL]
order_delivery coupon_status varchar(100) NO NOT_USED
order_delivery ssg_transaction_id varchar(200) YES [NULL]
order_delivery expire_at datetime YES [NULL]
order_delivery choice_select_product_id int YES [NULL]
order_delivery coupon_issued_at datetime YES [NULL]
order_delivery coupon_num varchar(100) YES [NULL]
order_delivery trade_at datetime YES [NULL]
order_delivery galaxia_balance int NO 0
order_delivery api_error_code varchar(256) YES [NULL]
order_delivery api_error_message varchar(256) YES [NULL]
order_delivery encourage_at datetime YES [NULL]
order_delivery resend_at datetime YES [NULL]
order_delivery resend_count int NO 0
order_delivery replaced_from_id bigint YES [NULL]
order_delivery failed_at datetime YES [NULL]
order_delivery claimed_at datetime(6) YES [NULL]
order_delivery discarded_at datetime YES [NULL]
order_delivery refunded_at datetime(6) YES [NULL]
order_delivery refund_status enum('PROGRESS','APPROVE','COMPLETE') YES [NULL]
order_delivery refund_ratio int YES [NULL]
order_delivery settle_fee decimal(5,2) YES [NULL]
order_delivery settle_price_adjustment varchar(20) YES [NULL]
order_delivery settle_discount_type varchar(50) YES [NULL]
order_delivery refund_register_at datetime YES [NULL]
order_delivery bank_name varchar(255) YES [NULL]
order_delivery bank_account varchar(255) YES [NULL]
order_delivery bank_account_owner varchar(255) YES [NULL]
order_delivery refund_at datetime YES [NULL]
order_delivery approve_at datetime YES [NULL]
order_delivery actual_send_at datetime YES [NULL]
order_delivery email_receiver_phone varchar(512) YES [NULL]
order_delivery trade_place varchar(200) YES [NULL]
order_delivery original_delivery_target varchar(128) YES [NULL]
order_delivery choice_post_send_status varchar(20) YES [NULL]
order_delivery choice_post_send_claim_token varchar(64) YES [NULL]
order_delivery choice_post_send_claimed_at datetime(6) YES [NULL]
order_delivery choice_post_sent_at datetime(6) YES [NULL]
order_delivery choice_selection_claim_token varchar(64) YES [NULL]
order_delivery choice_selection_claimed_at datetime(6) YES [NULL]
order_delivery choice_selection_attempt_key varchar(64) YES [NULL]
order_delivery choice_selection_reconcile_required_at datetime(6) YES [NULL]
order_delivery email_coupon_claim_token varchar(64) YES [NULL]
order_delivery email_coupon_claimed_at datetime(6) YES [NULL]
order_delivery email_coupon_attempt_key varchar(64) YES [NULL]
order_delivery email_coupon_reconcile_required_at datetime(6) YES [NULL]
order_delivery_attempt id bigint NO PRI [NULL] auto_increment
order_delivery_attempt order_delivery_id int NO MUL [NULL]
order_delivery_attempt attempt_type varchar(20) NO MUL [NULL]
order_delivery_attempt status varchar(20) NO PENDING
order_delivery_attempt created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
order_delivery_attempt deducted_at datetime(6) YES [NULL]
order_delivery_attempt sent_at datetime(6) YES [NULL]
order_delivery_attempt failed_at datetime(6) YES [NULL]
order_delivery_attempt completed_at datetime(6) YES [NULL]
order_delivery_attempt failure_reason varchar(500) YES [NULL]
order_delivery_refund id bigint NO PRI [NULL] auto_increment
order_delivery_refund order_delivery_id int NO UNI [NULL]
order_delivery_refund user_id int NO MUL [NULL]
order_delivery_refund refund_amount int NO [NULL]
order_delivery_refund restore_type enum('BALANCE','COMPANY_BALANCE','ALL_SETTLE_AMOUNT') NO [NULL]
order_delivery_refund is_settle_complete tinyint NO [NULL]
order_delivery_refund is_settle_balance tinyint NO [NULL]
order_delivery_refund source_path enum('CS_DISCARD','BATCH_FAIL','EXTERNAL_CANCEL','EXTERNAL_FAIL','ORDER_CANCEL') NO MUL [NULL]
order_delivery_refund operator_user_id int YES [NULL]
order_delivery_refund memo varchar(255) YES [NULL]
order_delivery_refund refunded_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
order_delivery_refund ssg_balance_settled tinyint(1) NO MUL 1
order_delivery_refund ssg_recover_token varchar(26) YES [NULL]
order_delivery_refund ssg_recover_lease_until datetime(6) YES [NULL]
order_delivery_refund ssg_recover_attempts int NO 0
order_delivery_refund ssg_recover_escalated_at datetime(6) YES [NULL]
order_delivery_ssg_insert_state id int NO PRI [NULL] auto_increment
order_delivery_ssg_insert_state order_delivery_id int NO UNI [NULL]
order_delivery_ssg_insert_state state enum('ATTEMPTED','CONFIRMED','FAILED') NO MUL [NULL]
order_delivery_ssg_insert_state created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
order_delivery_ssg_insert_state updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
order_from_definition id bigint unsigned NO PRI [NULL] auto_increment
order_from_definition type varchar(100) NO [NULL]
order_from_definition from varchar(100) NO [NULL]
order_from_definition created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
order_from_definition updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
order_from_definition deleted_at datetime(6) YES [NULL]
order_from_definition user_id int YES [NULL]
order_from_definition request_status enum('PENDING','APPROVED','REJECTED') YES PENDING
order_from_definition is_default tinyint(1) NO 0
order_from_definition telecom_cert_type enum('FILE_ATTACHED','PRE_DELIVERED') YES [NULL]
order_from_definition telecom_cert_file varchar(500) YES [NULL]
order_from_definition reject_reason text YES [NULL]
order_history created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
order_history updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
order_history deleted_at datetime(6) YES [NULL]
order_history id int NO PRI [NULL] auto_increment
order_history order_delivery_id int YES [NULL]
order_history user_id int YES [NULL]
order_history type varchar(50) YES [NULL]
order_history content varchar(5000) YES [NULL]
order_history send_method varchar(20) YES [NULL]
order_history before_change varchar(50) YES [NULL]
order_history after_change varchar(50) YES [NULL]
order_history destroy_amount int YES [NULL]
order_history restore_amount int YES [NULL]
order_like id int unsigned NO PRI [NULL] auto_increment
order_like user_id int NO [NULL]
order_like order_id int NO [NULL]
order_like is_like tinyint(1) NO 1
order_like created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
order_like updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
order_like deleted_at datetime(6) YES [NULL]
order_manual_entry id int NO PRI [NULL] auto_increment
order_manual_entry order_id int NO MUL [NULL]
order_manual_entry row_index int NO [NULL]
order_manual_entry phone_number varchar(128) NO [NULL]
order_manual_entry send_amount int NO [NULL]
order_manual_entry replace_character1 varchar(200) YES [NULL]
order_manual_entry replace_character2 varchar(200) YES [NULL]
order_manual_entry replace_character3 varchar(200) YES [NULL]
order_manual_entry created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
order_manual_entry updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
order_manual_entry deleted_at datetime(6) YES [NULL]
order_payment_allocation id bigint NO PRI [NULL] auto_increment
order_payment_allocation order_id int NO UNI [NULL]
order_payment_allocation wallet_account_id bigint NO MUL [NULL]
order_payment_allocation gross_settlement_amount int NO [NULL]
order_payment_allocation point_used_amount int NO 0
order_payment_allocation payable_settlement_amount int NO [NULL]
order_payment_allocation deposit_used_amount int NO 0
order_payment_allocation credit_used_amount int NO 0
order_payment_allocation credit_excess_amount int NO 0
order_payment_allocation card_surcharge_amount int NO 0
order_payment_allocation card_surcharge_applied tinyint(1) NO 0
order_payment_allocation has_discount tinyint(1) NO 0
order_payment_allocation settle_method_snapshot varchar(20) YES [NULL]
order_payment_allocation point_restored_amount int NO 0
order_payment_allocation credit_excess_restored_amount int NO 0
order_payment_allocation credit_used_restored_amount int NO 0
order_payment_allocation deposit_restored_amount int NO 0
order_payment_allocation point_skipped_expired_amount int NO 0
order_payment_allocation created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
order_payment_allocation updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
order_payment_allocation released_at datetime(6) YES [NULL]
order_payment_allocation release_reason varchar(200) YES [NULL]
order_payment_allocation_line id bigint NO PRI [NULL] auto_increment
order_payment_allocation_line allocation_id bigint NO MUL [NULL]
order_payment_allocation_line order_id int NO MUL [NULL]
order_payment_allocation_line order_product_mapping_id int NO [NULL]
order_payment_allocation_line order_delivery_id int YES MUL [NULL]
order_payment_allocation_line product_id int YES [NULL]
order_payment_allocation_line brand_id int YES [NULL]
order_payment_allocation_line category varchar(100) YES [NULL]
order_payment_allocation_line partner_company_id int YES [NULL]
order_payment_allocation_line order_type varchar(30) NO [NULL]
order_payment_allocation_line gross_settlement_amount int NO [NULL]
order_payment_allocation_line applied_fee_percent int YES [NULL]
order_payment_allocation_line applied_price_adjustment varchar(20) YES [NULL]
order_payment_allocation_line point_used_amount int NO 0
order_payment_allocation_line payable_base int NO [NULL]
order_payment_allocation_line deposit_used_amount int NO 0
order_payment_allocation_line credit_used_amount int NO 0
order_payment_allocation_line credit_excess_amount int NO 0
order_payment_allocation_line created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
order_payment_refund_event id bigint NO PRI [NULL] auto_increment
order_payment_refund_event allocation_id bigint NO MUL [NULL]
order_payment_refund_event order_id int NO MUL [NULL]
order_payment_refund_event event_type varchar(30) NO [NULL]
order_payment_refund_event affected_delivery_ids json NO [NULL]
order_payment_refund_event refunded_gross_base int NO [NULL]
order_payment_refund_event refunded_payable_base int NO [NULL]
order_payment_refund_event refunded_card_surcharge_amount int NO [NULL]
order_payment_refund_event refunded_point_amount int NO 0
order_payment_refund_event refunded_deposit_amount int NO 0
order_payment_refund_event refunded_credit_used_amount int NO 0
order_payment_refund_event refunded_credit_excess_amount int NO 0
order_payment_refund_event point_skipped_expired_amount int NO 0
order_payment_refund_event idempotency_key varchar(120) NO UNI [NULL]
order_payment_refund_event reversed_at datetime(6) YES [NULL]
order_payment_refund_event reversed_by_wallet_transaction_id bigint YES [NULL]
order_payment_refund_event created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
order_point_usage id bigint NO PRI [NULL] auto_increment
order_point_usage allocation_id bigint NO [NULL]
order_point_usage order_id int NO MUL [NULL]
order_point_usage order_delivery_id int YES MUL [NULL]
order_point_usage point_grant_id bigint NO MUL [NULL]
order_point_usage used_amount int NO [NULL]
order_point_usage restored_amount int NO 0
order_point_usage skipped_expired_amount int NO 0
order_point_usage expires_at_snapshot datetime YES [NULL]
order_point_usage created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
order_point_usage updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
order_product_mapping id int NO PRI [NULL] auto_increment
order_product_mapping order_id int NO [NULL]
order_product_mapping product_id int NO [NULL]
order_product_mapping created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
order_product_mapping updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
order_product_mapping deleted_at datetime(6) YES [NULL]
order_product_mapping amount int NO [NULL]
order_product_mapping top_image_path varchar(255) NO [NULL]
order_product_mapping mid_image_path varchar(255) NO [NULL]
order_product_mapping settle_discount_type enum('ONE','CONTRACT') YES [NULL]
order_product_mapping price_adjustment enum('DISCOUNT','ADDITIONAL') YES [NULL]
order_product_mapping fee int YES [NULL]
order_product_mapping send_method varchar(100) YES [NULL]
order_product_mapping send_tail_text varchar(100) YES [NULL]
order_product_mapping request_to_destroy_personal_info_day int YES [NULL]
order_product_mapping from_phone_number varchar(20) YES [NULL]
order_product_mapping send_title varchar(24) YES [NULL]
order_product_mapping send_content varchar(2500) YES [NULL]
order_product_mapping from_email varchar(100) YES [NULL]
order_product_mapping email_send_type enum('QR','URL') YES [NULL]
order_product_mapping use_email_content text YES [NULL]
order_product_mapping send_request_at datetime YES [NULL]
order_product_mapping send_type varchar(50) YES [NULL]
order_product_mapping encourage_day int YES [NULL]
order_product_mapping galaxia_duration smallint YES [NULL]
order_product_mapping test_delivery_count int NO 0
order_product_mapping snapshot_product_price int YES [NULL]
order_product_mapping snapshot_product_name varchar(255) YES [NULL]
order_product_mapping snapshot_product_brand_name varchar(255) YES [NULL]
order_product_mapping snapshot_product_expire_day int YES [NULL]
order_product_mapping snapshot_product_image_path varchar(500) YES [NULL]
order_real_product created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
order_real_product updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
order_real_product deleted_at datetime(6) YES [NULL]
order_real_product id int NO PRI [NULL] auto_increment
order_real_product event_name varchar(100) NO [NULL]
order_real_product finished_at datetime YES [NULL]
order_real_product business_user_id int NO [NULL]
order_real_product user_id int NO [NULL]
order_real_product status enum('ORDER_PENDING','ORDER_CONFIRM','ORDER_COMPLETED','STORAGE_COMPLETED','DELIVERY_PROGRESS','DELIVERY_COMPLETED','ORDER_CANCELED','ORDER_EDIT_REQUEST') YES [NULL]
order_real_product_mapping created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
order_real_product_mapping updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
order_real_product_mapping deleted_at datetime(6) YES [NULL]
order_real_product_mapping id int NO PRI [NULL] auto_increment
order_real_product_mapping public_charge_tax_payment enum('NONE','PERSON','COMPANY') YES [NULL]
order_real_product_mapping process_method enum('PRE','POST') NO [NULL]
order_real_product_mapping is_process tinyint NO [NULL]
order_real_product_mapping real_product_order_id int NO [NULL]
order_real_product_mapping product_id int NO [NULL]
order_real_product_mapping quantity int NO [NULL]
order_real_product_mapping price int NO [NULL]
order_real_product_mapping total_price int NO [NULL]
order_real_product_mapping standard_amount int NO [NULL]
order_real_product_mapping total_tax_amount int NO [NULL]
order_real_product_mapping tracking_number varchar(255) YES [NULL]
order_real_product_mapping delivery_status enum('UNKNOWN','INFORMATION_RECEIVED','AT_PICKUP','IN_TRANSIT','OUT_FOR_DELIVERY','ATTEMPT_FAIL','DELIVERED','AVAILABLE_FOR_PICKUP','EXCEPTION') YES [NULL]
order_real_product_mapping writer varchar(100) YES [NULL]
order_real_product_mapping partner_company_id int YES [NULL]
order_real_product_mapping buy_method varchar(50) YES [NULL]
order_real_product_mapping offline_address varchar(200) YES [NULL]
order_real_product_mapping offline_person_name varchar(50) YES [NULL]
order_real_product_mapping offline_phone_number varchar(20) YES [NULL]
order_real_product_mapping receiving_method varchar(20) YES [NULL]
order_real_product_mapping payment_method varchar(20) YES [NULL]
order_real_product_mapping payment_bank varchar(50) YES [NULL]
order_real_product_mapping payment_account_info varchar(200) YES [NULL]
order_real_product_mapping remarks text YES [NULL]
order_real_product_mapping progress_status varchar(50) YES [NULL]
order_real_product_mapping file_path text YES [NULL]
order_receipt id int NO PRI [NULL] auto_increment
order_receipt user_id int NO [NULL]
order_receipt title varchar(100) NO [NULL]
order_receipt status varchar(50) NO [NULL]
order_receipt file_path text YES [NULL]
order_receipt reject_reason varchar(200) YES [NULL]
order_receipt request_note text YES [NULL]
order_receipt confirm_note text YES [NULL]
order_receipt memo text YES [NULL]
order_receipt register_at datetime NO [NULL]
order_receipt processed_at datetime YES [NULL]
order_receipt processed_user_id int YES [NULL]
order_receipt created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
order_receipt updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
order_receipt deleted_at datetime(6) YES [NULL]
other_service_sale id int NO PRI [NULL] auto_increment
other_service_sale user_id int NO [NULL]
other_service_sale business_user_id int NO [NULL]
other_service_sale shipping_storage_id int NO [NULL]
other_service_sale sale_type_id int NO [NULL]
other_service_sale event_name varchar(255) NO [NULL]
other_service_sale prove_at date NO [NULL]
other_service_sale event_content varchar(255) NO [NULL]
other_service_sale etc varchar(255) YES [NULL]
other_service_sale created_at datetime YES CURRENT_TIMESTAMP DEFAULT_GENERATED
other_service_sale updated_at datetime YES CURRENT_TIMESTAMP DEFAULT_GENERATED on update CURRENT_TIMESTAMP
other_service_sale deleted_at datetime YES [NULL]
other_service_sale is_vat tinyint(1) NO [NULL]
other_service_sale_product id int NO PRI [NULL] auto_increment
other_service_sale_product code varchar(255) NO [NULL]
other_service_sale_product brand_name varchar(255) NO [NULL]
other_service_sale_product name varchar(255) NO [NULL]
other_service_sale_product price varchar(255) NO [NULL]
other_service_sale_product created_at datetime YES CURRENT_TIMESTAMP DEFAULT_GENERATED
other_service_sale_product updated_at datetime YES CURRENT_TIMESTAMP DEFAULT_GENERATED on update CURRENT_TIMESTAMP
other_service_sale_product deleted_at datetime YES [NULL]
other_service_sale_product_mapping id int NO PRI [NULL] auto_increment
other_service_sale_product_mapping other_service_sale_id int NO [NULL]
other_service_sale_product_mapping other_service_sale_product_id int NO [NULL]
other_service_sale_product_mapping quantity int NO [NULL]
other_service_sale_product_mapping total_price int NO [NULL]
other_service_sale_product_mapping created_at datetime YES CURRENT_TIMESTAMP DEFAULT_GENERATED
other_service_sale_product_mapping updated_at datetime YES CURRENT_TIMESTAMP DEFAULT_GENERATED on update CURRENT_TIMESTAMP
other_service_sale_product_mapping deleted_at datetime YES [NULL]
other_service_sale_type id int NO PRI [NULL] auto_increment
other_service_sale_type code varchar(255) NO [NULL]
other_service_sale_type name varchar(255) NO [NULL]
other_service_sale_type created_at datetime YES CURRENT_TIMESTAMP DEFAULT_GENERATED
other_service_sale_type updated_at datetime YES CURRENT_TIMESTAMP DEFAULT_GENERATED on update CURRENT_TIMESTAMP
other_service_sale_type deleted_at datetime YES [NULL]
partner_company created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
partner_company updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
partner_company deleted_at datetime(6) YES [NULL]
partner_company id int NO PRI [NULL] auto_increment
partner_company corporate_number varchar(100) YES [NULL]
partner_company business_number varchar(100) NO [NULL]
partner_company business_name varchar(100) NO [NULL]
partner_company business_address varchar(100) NO [NULL]
partner_company business_phone_number varchar(100) NO [NULL]
partner_company person_name varchar(100) NO [NULL]
partner_company person_phone_number varchar(20) NO [NULL]
partner_company person_email varchar(100) NO [NULL]
partner_company settle_condition varchar(100) NO [NULL]
partner_company settle_method varchar(100) NO [NULL]
partner_company maximum_limit int NO [NULL]
partner_company bank_name varchar(100) NO [NULL]
partner_company bank_number varchar(100) NO [NULL]
partner_company code varchar(100) NO UNI [NULL]
partner_company status varchar(100) NO ACTIVE
partner_company settle_day int NO [NULL]
partner_company type enum('GIFT_SHOW','GS_M_BIZ','GIFTIEL','CULTURELAND','GALAXIA','SSG','DAOU') YES [NULL]
partner_company validity_starts_next_day tinyint(1) NO 1
partner_company_extern_history created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
partner_company_extern_history updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
partner_company_extern_history deleted_at datetime(6) YES [NULL]
partner_company_extern_history id int NO PRI [NULL] auto_increment
partner_company_extern_history context text NO [NULL]
partner_company_extern_history is_success tinyint NO [NULL]
partner_company_extern_history type enum('GIFT_SHOW','GS_M_BIZ','GIFTIEL','CULTURELAND','GALAXIA','SSG','DAOU') NO [NULL]
partner_company_extern_history order_delivery_id int YES [NULL]
password_policy id int NO PRI [NULL] auto_increment
password_policy password_expiry_days int NO [NULL]
password_policy created_by_user_id int YES MUL [NULL]
password_policy created_at datetime NO CURRENT_TIMESTAMP DEFAULT_GENERATED
password_policy updated_at datetime NO CURRENT_TIMESTAMP DEFAULT_GENERATED on update CURRENT_TIMESTAMP
password_policy deleted_at datetime YES [NULL]
pin_issue_dedup transaction_id varchar(64) NO PRI [NULL]
pin_issue_dedup order_delivery_id int NO MUL [NULL]
pin_issue_dedup partner_type varchar(32) NO [NULL]
pin_issue_dedup bar_code varchar(64) YES [NULL]
pin_issue_dedup recovered_from enum('DEDUP','CHECK_API','HISTORY_LOG','FRESH_ISSUE') NO FRESH_ISSUE
pin_issue_dedup issued_at datetime(6) NO [NULL]
point_grant id bigint NO PRI [NULL] auto_increment
point_grant wallet_account_id bigint NO MUL [NULL]
point_grant original_amount int NO [NULL]
point_grant remaining_amount int NO [NULL]
point_grant expires_at datetime YES [NULL]
point_grant reason varchar(200) YES [NULL]
point_grant active tinyint(1) NO 1
point_grant created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
point_grant updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
point_policy_rule id bigint NO PRI [NULL] auto_increment
point_policy_rule owner_type varchar(20) NO MUL [NULL]
point_policy_rule owner_id bigint YES [NULL]
point_policy_rule effect varchar(10) NO [NULL]
point_policy_rule scope_type varchar(30) NO MUL [NULL]
point_policy_rule scope_id bigint YES [NULL]
point_policy_rule scope_code varchar(100) YES [NULL]
point_policy_rule active tinyint(1) NO 1
point_policy_rule created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
point_policy_rule updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
popular_product id int NO PRI [NULL] auto_increment
popular_product product_id int NO [NULL]
popular_product unique_company_count int NO [NULL]
popular_product total_quantity int NO [NULL]
popular_product rank int NO MUL [NULL]
popular_product calculated_at datetime NO [NULL]
popular_product created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
popular_product updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
popular_product deleted_at datetime(6) YES [NULL]
product created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
product updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
product deleted_at datetime(6) YES [NULL]
product id int NO PRI [NULL] auto_increment
product code varchar(256) NO UNI [NULL]
product brand_id int NO [NULL]
product name varchar(100) NO [NULL]
product price int NO [NULL]
product expire_day int NO [NULL]
product galaxia_duration smallint YES [NULL]
product category varchar(50) NO [NULL]
product classification_id int YES [NULL]
product settle_method varchar(50) NO [NULL]
product settle_percent int NO [NULL]
product image_path varchar(512) NO [NULL]
product type varchar(100) NO [NULL]
product coupon_method varchar(10) NO [NULL]
product partner_company_id int NO [NULL]
product memo varchar(10000) YES [NULL]
product partner_company_code varchar(256) YES [NULL]
product use_status varchar(255) NO [NULL]
product is_cancelable tinyint(1) NO 1
product color varchar(100) YES [NULL]
product status enum('ON_SALE','END_SALE') YES [NULL]
product ssg_price_key int YES UNI [NULL] VIRTUAL GENERATED
product_choice_mapping id int unsigned NO PRI [NULL] auto_increment
product_choice_mapping choice_product_id int unsigned NO [NULL]
product_choice_mapping product_id int unsigned NO [NULL]
product_choice_mapping created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
product_choice_mapping updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
product_choice_mapping deleted_at datetime(6) YES [NULL]
product_like id int unsigned NO PRI [NULL] auto_increment
product_like user_id int NO [NULL]
product_like product_id int NO [NULL]
product_like is_like tinyint(1) NO 1
product_like created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
product_like updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
product_like deleted_at datetime(6) YES [NULL]
product_request id int NO PRI [NULL] auto_increment
product_request requester_id int NO MUL [NULL]
product_request delivery_company varchar(256) NO [NULL]
product_request brand_name varchar(256) NO [NULL]
product_request product_name varchar(256) NO [NULL]
product_request price int NO [NULL]
product_request product_code varchar(128) NO MUL [NULL]
product_request partner_company varchar(256) NO [NULL]
product_request expire_day int NO [NULL]
product_request description text YES [NULL]
product_request brand_id int YES MUL [NULL]
product_request partner_company_id int YES MUL [NULL]
product_request status enum('PENDING','IN_PROGRESS','COMPLETED','REJECTED') NO MUL PENDING
product_request assignee_id int YES MUL [NULL]
product_request product_id int YES MUL [NULL]
product_request completed_at datetime YES [NULL]
product_request rejection_reason text YES [NULL]
product_request created_at datetime NO MUL CURRENT_TIMESTAMP DEFAULT_GENERATED
product_request updated_at datetime NO CURRENT_TIMESTAMP DEFAULT_GENERATED on update CURRENT_TIMESTAMP
product_request deleted_at datetime YES [NULL]
product_request_history id int NO PRI [NULL] auto_increment
product_request_history product_request_id int NO MUL [NULL]
product_request_history user_id int NO MUL [NULL]
product_request_history status enum('PENDING','IN_PROGRESS','COMPLETED','REJECTED') NO [NULL]
product_request_history memo text YES [NULL]
product_request_history created_at datetime NO CURRENT_TIMESTAMP DEFAULT_GENERATED
product_request_history updated_at datetime NO CURRENT_TIMESTAMP DEFAULT_GENERATED on update CURRENT_TIMESTAMP
product_request_history deleted_at datetime YES [NULL]
product_shared_list_file id int NO PRI [NULL] auto_increment
product_shared_list_file user_id int NO [NULL]
product_shared_list_file file_name varchar(255) NO [NULL]
product_shared_list_file file_url varchar(500) NO [NULL]
product_shared_list_file created_at datetime(6) NO MUL CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
product_shared_list_file updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
product_shared_list_file deleted_at datetime(6) YES MUL [NULL]
product_update_history created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
product_update_history updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
product_update_history deleted_at datetime(6) YES [NULL]
product_update_history id int NO PRI [NULL] auto_increment
product_update_history product_id int NO [NULL]
product_update_history key varchar(256) NO [NULL]
product_update_history key_name varchar(256) NO [NULL]
product_update_history before_value varchar(512) YES [NULL]
product_update_history after_value varchar(512) YES [NULL]
product_update_history user_id int NO [NULL]
product_update_history reason varchar(512) YES [NULL]
qna created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
qna updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
qna deleted_at datetime(6) YES [NULL]
qna id int NO PRI [NULL] auto_increment
qna user_id int NO [NULL]
qna title varchar(50) NO [NULL]
qna content varchar(200) NO [NULL]
qna answer varchar(255) YES [NULL]
qna register_date date NO [NULL]
qna status enum('WAIT','OK') NO [NULL]
qna file_path text YES [NULL]
qna main_category enum('PRODUCT_INQUIRY','PROOF','CS','ETC') NO ETC
qna sub_category enum('RESEND','NUMBER_CHANGE','DISPOSE') YES [NULL]
requirement id int NO PRI [NULL] auto_increment
requirement user_id int NO [NULL]
requirement title varchar(100) NO [NULL]
requirement type varchar(50) NO [NULL]
requirement related_page varchar(200) YES [NULL]
requirement priority varchar(50) NO [NULL]
requirement content text NO [NULL]
requirement status varchar(50) NO NEW
requirement created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
requirement updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
requirement deleted_at datetime(6) YES [NULL]
requirement_attachment id int NO PRI [NULL] auto_increment
requirement_attachment requirement_id int NO [NULL]
requirement_attachment file_url varchar(500) NO [NULL]
requirement_attachment file_name varchar(200) NO [NULL]
requirement_attachment created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
requirement_attachment updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
requirement_attachment deleted_at datetime(6) YES [NULL]
requirement_comment id int NO PRI [NULL] auto_increment
requirement_comment requirement_id int NO [NULL]
requirement_comment user_id int NO [NULL]
requirement_comment content text NO [NULL]
requirement_comment created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
requirement_comment updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
requirement_comment deleted_at datetime(6) YES [NULL]
shipping_storage id int NO PRI [NULL] auto_increment
shipping_storage code varchar(255) NO [NULL]
shipping_storage type enum('STORAGE','FACTORY','OUTSOURCING_FACTORY') NO [NULL]
shipping_storage name varchar(255) NO [NULL]
shipping_storage created_at datetime YES CURRENT_TIMESTAMP DEFAULT_GENERATED
shipping_storage updated_at datetime YES CURRENT_TIMESTAMP DEFAULT_GENERATED on update CURRENT_TIMESTAMP
shipping_storage deleted_at datetime YES [NULL]
ssg_event created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
ssg_event updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
ssg_event deleted_at datetime(6) YES [NULL]
ssg_event id int NO PRI [NULL] auto_increment
ssg_event code varchar(20) NO [NULL]
ssg_event name varchar(20) NO [NULL]
ssg_event start_at datetime NO [NULL]
ssg_event end_at datetime NO [NULL]
ssg_event coupon_expiration int NO [NULL]
ssg_event event_price int NO [NULL]
ssg_event event_balance int NO 0
ssg_event no varchar(100) NO [NULL]
ssg_event order int NO 1
ssg_event_amount_history created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
ssg_event_amount_history updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
ssg_event_amount_history deleted_at datetime(6) YES [NULL]
ssg_event_amount_history id int NO PRI [NULL] auto_increment
ssg_event_amount_history amount int YES [NULL]
ssg_event_amount_history balance int NO 0
ssg_event_amount_history ssg_event_id int YES [NULL]
ssg_event_amount_history order_id int YES [NULL]
ssg_event_amount_history is_temporary tinyint(1) YES 1
ssg_event_recovery_log id bigint NO PRI [NULL] auto_increment
ssg_event_recovery_log refund_ledger_id bigint NO UNI [NULL]
ssg_event_recovery_log ssg_event_id int NO [NULL]
ssg_event_recovery_log order_id int NO [NULL]
ssg_event_recovery_log amount int NO [NULL]
ssg_event_recovery_log applied_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
ssg_issue_log id int NO PRI [NULL] auto_increment
ssg_issue_log bar_code varchar(32) NO MUL [NULL]
ssg_issue_log personal_code varchar(32) NO MUL [NULL]
ssg_issue_log order_delivery_id int NO MUL [NULL]
ssg_issue_log ssg_transaction_id varchar(64) NO [NULL]
ssg_issue_log event_no varchar(32) NO [NULL]
ssg_issue_log event_seq int YES [NULL]
ssg_issue_log ssg_event_id int YES [NULL]
ssg_issue_log inserted_at datetime(6) NO [NULL]
ssg_issue_log expire_at datetime YES [NULL]
ssg_issue_log encourage_at datetime YES [NULL]
ssg_issue_log coupon_num varchar(100) YES [NULL]
ssg_resend_deduct_pending id bigint NO PRI [NULL] auto_increment
ssg_resend_deduct_pending resend_deduction_id varchar(26) NO UNI [NULL]
ssg_resend_deduct_pending ssg_event_id int NO [NULL]
ssg_resend_deduct_pending order_id int NO [NULL]
ssg_resend_deduct_pending amount int NO [NULL]
ssg_resend_deduct_pending purpose varchar(20) NO [NULL]
ssg_resend_deduct_pending issue_order_delivery_id int YES [NULL]
ssg_resend_deduct_pending issue_attempted_at datetime(6) YES [NULL]
ssg_resend_deduct_pending resolved_at datetime(6) YES MUL [NULL]
ssg_resend_deduct_pending resolution varchar(20) YES [NULL]
ssg_resend_deduct_pending recover_token varchar(26) YES [NULL]
ssg_resend_deduct_pending recover_lease_until datetime(6) YES [NULL]
ssg_resend_deduct_pending recover_attempts int NO 0
ssg_resend_deduct_pending recover_escalated_at datetime(6) YES [NULL]
ssg_resend_deduct_pending created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
ssg_resend_deduct_recovery id bigint NO PRI [NULL] auto_increment
ssg_resend_deduct_recovery resend_deduction_id varchar(26) NO UNI [NULL]
ssg_resend_deduct_recovery ssg_event_id int NO [NULL]
ssg_resend_deduct_recovery order_id int NO [NULL]
ssg_resend_deduct_recovery amount int NO [NULL]
ssg_resend_deduct_recovery applied_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
ssg_reservation_range id int NO PRI [NULL] auto_increment
ssg_reservation_range start_date date NO [NULL]
ssg_reservation_range end_date date NO [NULL]
ssg_reservation_range updated_by int YES [NULL]
ssg_reservation_range created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
ssg_reservation_range updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
ssg_reservation_range deleted_at datetime(6) YES [NULL]
test_order_delivery id int NO PRI [NULL] auto_increment
test_order_delivery status varchar(50) NO [NULL]
test_order_delivery order_product_mapping_id int NO MUL [NULL]
test_order_delivery delivery_method varchar(50) NO [NULL]
test_order_delivery delivery_target varchar(128) NO [NULL]
test_order_delivery image_path varchar(512) YES [NULL]
test_order_delivery replace_character1 varchar(200) YES [NULL]
test_order_delivery replace_character2 varchar(200) YES [NULL]
test_order_delivery replace_character3 varchar(200) YES [NULL]
test_order_delivery send_request_at datetime NO [NULL]
test_order_delivery expire_at datetime YES [NULL]
test_order_delivery bar_code varchar(256) YES [NULL]
test_order_delivery personal_code varchar(50) YES [NULL]
test_order_delivery coupon_status varchar(50) YES NOT_USED
test_order_delivery choice_select_product_id int YES [NULL]
test_order_delivery created_at datetime YES CURRENT_TIMESTAMP DEFAULT_GENERATED
test_order_delivery updated_at datetime YES CURRENT_TIMESTAMP DEFAULT_GENERATED on update CURRENT_TIMESTAMP
test_order_delivery deleted_at datetime YES [NULL]
user created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
user updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
user deleted_at datetime(6) YES [NULL]
user id int NO PRI [NULL] auto_increment
user company_id bigint YES MUL [NULL]
user settlement_code varchar(50) NO MUL
user department_id int YES MUL [NULL]
user email varchar(100) NO [NULL]
user password varchar(256) NO [NULL]
user is_password_reset tinyint NO [NULL]
user authority varchar(256) NO [NULL]
user person_name varchar(100) NO [NULL]
user person_phone_number varchar(20) NO [NULL]
user person_email varchar(500) NO [NULL]
user person_code varchar(100) NO [NULL]
user person_category varchar(100) NO NORMAL
user login_verify_method varchar(10) NO EMAIL
user corporate_number varchar(100) NO [NULL]
user is_head_person tinyint(1) NO [NULL]
user ip varchar(100) YES [NULL]
user settle_method varchar(100) NO [NULL]
user bank_name varchar(100) NO [NULL]
user bank_number varchar(100) NO [NULL]
user card_name varchar(100) NO [NULL]
user card_number varchar(100) NO [NULL]
user balance int NO 0
user settle_condition enum('PRE_PAYMENT','POST_PAYMENT') NO [NULL]
user status enum('USED','NOT_USED','NOT_APPROVED','LEAVE') NO [NULL]
user business_type enum('INDIVIDUAL','CORPORATE') YES [NULL]
user business_grade varchar(100) NO S+
user from_phone_number varchar(20) YES [NULL]
user settle_period_condition enum('CURRENT_MONTH','NEXT_MONTH','NEXT_MONTH_AFTER','DELIVERY_DATE') YES [NULL]
user settle_period_count int YES [NULL]
user all_settle_amount int YES 0
user service_amount int YES 0
user duplicate_phone_limit int NO 0
user authority_list varchar(1024) YES [NULL]
user api_key_hash varchar(64) YES UNI [NULL]
user password_changed_at datetime YES [NULL]
user allowed_send_methods varchar(100) NO ALIM_TALK,SMS,EMAIL
user document_company_type varchar(20) NO ENMAD
user locked_at datetime YES [NULL]
user is_login_locked tinyint(1) NO 0
user login_fail_count int NO 0
user last_activity_at datetime NO [NULL]
user suspended_at datetime YES [NULL]
user withdrawn_at datetime YES [NULL]
user anonymized_at datetime YES [NULL]
user hide_system_from_phone tinyint(1) NO 0
user_company id bigint NO PRI [NULL] auto_increment
user_company business_name varchar(100) NO [NULL]
user_company business_number varchar(100) NO UNI [NULL]
user_company business_address varchar(255) YES [NULL]
user_company business_phone_number varchar(50) YES [NULL]
user_company industry_type varchar(100) YES [NULL]
user_company industry_item varchar(100) YES [NULL]
user_company settle_method varchar(100) YES [NULL]
user_company maximum_limit int NO 0
user_company bank_name varchar(100) YES [NULL]
user_company bank_number varchar(100) YES [NULL]
user_company card_name varchar(100) YES [NULL]
user_company card_number varchar(100) YES [NULL]
user_company created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
user_company updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
user_company deleted_at datetime(6) YES [NULL]
user_company balance int NO 0
user_company balance_management_type varchar(20) NO COMPANY
user_discount id int NO PRI [NULL] auto_increment
user_discount user_id int YES [NULL]
user_discount primary_category varchar(100) YES [NULL]
user_discount group varchar(100) YES [NULL]
user_discount range varchar(100) YES [NULL]
user_discount price_percent int NO [NULL]
user_discount category enum('PRODUCT_GROUP','CATEGORY','BRAND') NO [NULL]
user_discount method enum('SECTION','BULK') NO [NULL]
user_discount compare_condition enum('ALL','MORE_THAN','LESS_THAN','OVER','LESS') NO [NULL]
user_discount price_adjustment enum('DISCOUNT','ADDITIONAL') NO [NULL]
user_discount partner_company_id int YES [NULL]
user_discount created_at timestamp NO CURRENT_TIMESTAMP DEFAULT_GENERATED
user_discount updated_at timestamp NO CURRENT_TIMESTAMP DEFAULT_GENERATED on update CURRENT_TIMESTAMP
user_discount deleted_at timestamp YES [NULL]
user_discount classification_id int YES [NULL]
user_drive created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
user_drive updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
user_drive deleted_at datetime(6) YES [NULL]
user_drive id int NO PRI [NULL] auto_increment
user_drive sender_id int NO [NULL]
user_drive receiver_id int NO [NULL]
user_drive title varchar(256) NO [NULL]
user_drive content text NO [NULL]
user_drive file_path text YES [NULL]
user_drive send_at datetime NO [NULL]
user_drive receive_at datetime YES [NULL]
user_drive status enum('REGISTER','PROGRESS','COMPLETE') NO [NULL]
user_drive reply_content text YES [NULL]
user_event_save_mapping created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
user_event_save_mapping updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
user_event_save_mapping deleted_at datetime(6) YES [NULL]
user_event_save_mapping id int NO PRI [NULL] auto_increment
user_event_save_mapping event_id int NO MUL [NULL]
user_event_save_mapping user_id int NO MUL [NULL]
user_sync_product_event id int NO PRI [NULL] auto_increment
user_sync_product_event business_user_id int NO MUL [NULL]
user_sync_product_event admin_user_id int YES MUL [NULL]
user_sync_product_event name varchar(255) NO [NULL]
user_sync_product_event code varchar(255) NO [NULL]
user_sync_product_event phone varchar(50) NO [NULL]
user_sync_product_event email varchar(255) NO [NULL]
user_sync_product_event status varchar(20) NO [NULL]
user_sync_product_event created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
user_sync_product_event updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
user_sync_product_event deleted_at datetime(6) YES [NULL]
user_sync_product_event person_name varchar(255) YES [NULL]
user_sync_product_event_mapping id int unsigned NO PRI [NULL] auto_increment
user_sync_product_event_mapping user_sync_product_event_id int unsigned NO [NULL]
user_sync_product_event_mapping product_id int unsigned NO [NULL]
user_sync_product_event_mapping created_at datetime NO CURRENT_TIMESTAMP DEFAULT_GENERATED
user_sync_product_event_mapping updated_at datetime NO CURRENT_TIMESTAMP DEFAULT_GENERATED on update CURRENT_TIMESTAMP
user_sync_product_event_mapping deleted_at datetime YES [NULL]
user_task_history id int unsigned NO PRI [NULL] auto_increment
user_task_history user_id int unsigned NO MUL [NULL]
user_task_history admin_user_id int unsigned NO MUL [NULL]
user_task_history content text YES [NULL]
user_task_history created_at datetime(6) YES CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
user_task_history updated_at datetime(6) YES CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
user_task_history deleted_at datetime(6) YES [NULL]
user_view_scope id int NO PRI [NULL] auto_increment
user_view_scope user_id int NO UNI [NULL]
user_view_scope scope_type enum('SELF','DEPARTMENT','COMPANY','ALL') NO SELF
user_view_scope dept_ids varchar(500) YES [NULL]
user_view_scope created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
user_view_scope updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
wallet_account id bigint NO PRI [NULL] auto_increment
wallet_account owner_type varchar(20) NO MUL [NULL]
wallet_account owner_id varchar(50) NO [NULL]
wallet_account deposit_balance int NO 0
wallet_account credit_limit int NO 0
wallet_account credit_used_amount int NO 0
wallet_account credit_excess_amount int NO 0
wallet_account settle_condition varchar(20) NO POST_PAYMENT
wallet_account settle_method varchar(20) NO CASH
wallet_account created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
wallet_account updated_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)
wallet_transaction id bigint NO PRI [NULL] auto_increment
wallet_transaction wallet_account_id bigint NO MUL [NULL]
wallet_transaction order_id int YES MUL [NULL]
wallet_transaction order_delivery_id int YES MUL [NULL]
wallet_transaction type varchar(40) NO [NULL]
wallet_transaction resource_type varchar(20) NO [NULL]
wallet_transaction amount int NO [NULL]
wallet_transaction balance_after int YES [NULL]
wallet_transaction memo varchar(500) YES [NULL]
wallet_transaction idempotency_key varchar(120) NO UNI [NULL]
wallet_transaction created_at datetime(6) NO CURRENT_TIMESTAMP(6) DEFAULT_GENERATED
