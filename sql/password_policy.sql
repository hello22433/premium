-- 비밀번호 정책 테이블 생성
CREATE TABLE IF NOT EXISTS password_policy (
    id INT PRIMARY KEY AUTO_INCREMENT COMMENT 'ID',
    password_expiry_days INT NOT NULL COMMENT '비밀번호 만료 기간 (일 단위)',
    created_by_user_id INT NULL COMMENT '설정한 관리자 ID',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성일시',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일시',
    deleted_at DATETIME NULL COMMENT '삭제일시 (soft delete)',
    FOREIGN KEY (created_by_user_id) REFERENCES user(id)
) COMMENT '비밀번호 정책 설정';

-- 초기 데이터 (90일, 관리자 ID는 NULL - 시스템 기본값)
INSERT INTO password_policy (password_expiry_days, created_by_user_id) VALUES (90, NULL);
