ALTER TABLE user
ADD COLUMN document_company_type VARCHAR(20) NOT NULL DEFAULT 'ENMAD'
COMMENT '기본 문서 양식 (ENMAD: 모바일이앤엠애드, SYSCUSS: 시스커스)';
