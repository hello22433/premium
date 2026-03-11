# 로그인 문자 인증 - 프론트엔드 작업 안내

## 개요
기존 이메일 인증 외에 문자(알림톡/SMS) 인증 방식이 추가되었습니다.
관리자가 사용자별로 인증 방식(`EMAIL` 또는 `PHONE`)을 설정하며, 로그인 시 해당 방식으로 인증합니다.

## API 변경사항

### 1. 로그인 응답 변경 (`POST /user/login-email-password`)

응답에 2개 필드가 추가되었습니다:

```json
{
  "userId": 1,
  "accessToken": null,
  "refreshToken": null,
  "isEmailVerify": false,
  "loginVerifyMethod": "EMAIL",       // 추가: "EMAIL" | "PHONE"
  "maskedPhoneNumber": "*******1234", // 추가: 마스킹된 연락처
  "personEmails": ["test@example.com"],
  "needEmailSelection": true,
  // ... 기존 필드들
}
```

- `loginVerifyMethod`: 인증 방식. `EMAIL`이면 기존 이메일 인증, `PHONE`이면 문자 인증
- `maskedPhoneNumber`: 마스킹된 전화번호 (끝 4자리만 노출)

### 2. 문자 인증코드 발송 (`POST /user/login/phone/send`) - 신규

등록된 담당자 연락처(`personPhoneNumber`)로 알림톡/SMS 인증코드를 발송합니다.

**Request:**
```json
{
  "email": "user@example.com"  // 계정 이메일 (로그인 ID). 이 계정의 담당자 연락처로 인증코드 발송
}
```

**Response:**
```json
{
  "id": 123  // 인증 이력 ID (verify 시 사용)
}
```

### 3. 문자 인증코드 검증 (`POST /user/login/phone/verify`) - 신규

**Request:**
```json
{
  "id": 123,              // send 응답의 id
  "email": "user@example.com",  // 계정 이메일 (로그인 ID)
  "code": "ABC123"        // 수신한 인증코드
}
```

**Response:** 200 OK (본문 없음)

검증 성공 후 다시 `POST /user/login-email-password`를 호출하면 토큰이 발급됩니다.

### 4. 에러 응답

| 상황 | 에러 메시지 |
|------|------------|
| 등록된 연락처 없음 | `등록된 연락처가 없습니다. 관리자에게 문의해주세요.` |
| 발송 실패 | `인증코드 발송에 실패했습니다. 잠시 후 다시 시도해주세요.` |
| 만료된 코드 | `만료된 인증 코드입니다.` |
| 코드 불일치 | `코드가 일치하지 않습니다.` |
| 이미 인증됨 | `이미 인증 완료된 코드입니다.` |

## 프론트엔드 로그인 플로우 변경

```
1. POST /user/login-email-password
   ↓
2. isEmailVerify === false 이면
   ↓
3. loginVerifyMethod 확인
   ├─ "EMAIL" → 기존 이메일 인증 플로우
   │   ├─ POST /user/login/email/send
   │   └─ POST /user/login/email/verify
   └─ "PHONE" → 문자 인증 플로우 (신규)
       ├─ maskedPhoneNumber 표시 ("*******1234 으로 인증코드를 발송합니다")
       ├─ POST /user/login/phone/send
       └─ POST /user/login/phone/verify
   ↓
4. 인증 성공 후 다시 POST /user/login-email-password → 토큰 발급
```

## 관리자 페이지 변경

### 계정 관리 상세/수정 화면

`loginVerifyMethod` 필드가 추가되었습니다:

- **조회**: `GET /user-management/:id` 응답에 `loginVerifyMethod` 포함
- **수정**: `PUT /user-management` 요청에 `loginVerifyMethod` 포함 (선택, 기본값 `EMAIL`)

UI에 셀렉트박스 추가:
- 라벨: "로그인 인증 방식"
- 옵션: `EMAIL` (이메일 인증) / `PHONE` (문자 인증)

## 인증코드 유효시간

이메일 인증과 동일 (현재 5분)
