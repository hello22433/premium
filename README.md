# 이팝콘 프리미엄

이팝콘 프리미엄 백엔드 서버입니다. 주문, 발송, 상품, 협력사 연동, 정산, 고객 대응 기능을 NestJS 기반 API로 제공합니다.

## 기술 스택

- Node.js 21.7.3
- NestJS 10.0.0
- TypeScript 5.7.2
- TypeORM 0.3.6
- MySQL 8.0.40
- MSSQL (Gemtek SMS 연동)
- Swagger (`@nestjs/swagger`)
- Schedule / Event Emitter / AWS S3 / SMTP / 외부 제휴사 API 연동

## 요구 사항

- Node.js 21.x
- npm
- MySQL 접속 정보
- SMS 발송 기능 사용 시 Gemtek MSSQL 접속 정보
- `.env.example`를 기반으로 한 `.env` 파일

## 주요 실행 정보

- 기본 포트: `3000` (`PORT` 환경 변수로 변경 가능)
- Swagger 문서: `/api`
- 정적 파일 서빙 경로: `/public`
- CORS: 전역 허용
- 전역 ValidationPipe: `whitelist`, `transform` 활성화
- 요청 바디 제한
  - JSON / `application/x-www-form-urlencoded`: `50mb`
  - XML / text XML: `10mb`
- 데이터베이스
  - 메인 DB: MySQL
  - 문자 발송 DB: Gemtek MSSQL

## 빠른 시작

1. `.env.example`를 참고하여 `.env` 파일을 작성합니다.
2. 의존성을 설치합니다.
3. 개발 서버를 실행합니다.
4. 실행 후 `/api`에서 Swagger 문서를 확인합니다.

```bash
npm install
npm run start:dev
```

# Node 설치

## 우분투(Ubuntu 24.04.1) 기준

```
sudo apt update && sudo apt upgrade

curl -fsSL https://deb.nodesource.com/setup_21.x | sudo -E bash -

sudo apt-get install nodejs

# 설치된 노드 버전 보기
node -v
```

## 환경 변수 가이드

- 자세한 키 목록은 `.env.example`을 참고합니다.
- 최소 확인이 필요한 주요 범주는 아래와 같습니다.
  - 서버: `ENVIRONMENT`, `PORT`
  - 메인 DB: `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USERNAME`, `DATABASE_PASSWORD`, `DATABASE_DATABASE`
  - DB 옵션: `DATABASE_LOGGING`, `DATABASE_SYNCHRONIZE`
  - 인증: `TOKEN_SECRET_KEY`, `ACCESS_TOKEN_EXPIRE_SECOND`, `REFRESH_TOKEN_EXPIRE_SECOND`
  - 메일/문자/알림톡: SMTP 설정, `ALIM_TALK_*`, `DATABASE_GEMTEK_SMS_*`
  - 프론트 수신 URL: `ALIM_TALK_RECEIVE_URL`, `EMAIL_RECEIVE_URL`, `SMS_CHOICE_URL`
  - 파일 저장소: `AWS_S3_*`
  - 제휴사/ERP 연동: Galaxia, Giftishow, CultureLand, GS M Biz, ERP 관련 키
  - 배치 처리: `BATCH_PAGE_SIZE`, `BATCH_API_TIMEOUT_MS`, `BATCH_RETRY_COUNT`, 파트너사별 `BATCH_CONCURRENCY_*`
- 민감 정보는 `.env.example` 값을 그대로 사용하지 말고 환경별 실제 값으로 교체해야 합니다.

## 주요 스크립트

```bash
# 개발 실행
npm run start
npm run start:dev
npm run start:debug

# 빌드 / 운영 실행
npm run build
npm run start:prod

# 품질 점검
npm run lint
npm run test
npm run test:cov
```

## 주요 모듈

- 사용자/권한: `user`, `user_management`, `department`, `auth`
- 상품/브랜드: `product`, `brand`, `popular_product`, `product_choice`
- 주문/수신/환불/정산: `order`, `order_receive`, `order_event`, `order_receipt`, `refund`, `settle`
- 발송/알림: `delivery`, `mail`, `sms`, `notification`, `message_archive`, `email_manual`
- 외부 연동: `partner_company`, `erp`, `customer_service`, `file`
- 운영 지원: `activity_log`, `requirement`, `inquiry`, `notice`, `qna`

## 개발 메모

- Swagger는 앱 기동 시 자동 생성되며 Bearer 인증을 지원합니다.
- 메인 DB 연결에는 snake case 네이밍 전략을 사용합니다.
- 트랜잭션 처리는 `typeorm-transactional` 기반으로 초기화됩니다.
- 일정성 작업은 `@nestjs/schedule`로 등록되어 있으며, 발송 배치가 이 구조를 사용합니다.
- 정적 리소스는 프로젝트 루트 `public` 디렉터리를 `/public`으로 서빙합니다.

# Architecture

- 기본적으로 레이어드 아키텍처를 참고하여 다음과 같은 규칙을 차용하고자 합니다.
- 각 레이어에 따라 책임과 역할을 구분하여 사용해 주세요.

---

## Application, Domain, Infrastructure example

### Api

- controller, Request DTO, Response DTO 등을 작성 한다.
  - controller
    - 주로 http api 를 사용하여, API 에 대한 spec 을 swagger 를 사용하여 상세하게 작성
      - 어떤 API 인지, 특이사항이 있는 API 일 경우 description에 작성하여 프론트와 공유
      - **request 와 response 는 반드시 "전부" 필수로 작성**
        - 자료형, 필수여부, 어떠한 값인지, null 인지 아닌지 여부
    - 하나의 URL 에는 Request 혹은 Response 가 0개 혹은 1개의 class를 가진다.
    - request 및, response dto는 재사용 하지 않는다.
      - 재사용 하고자 하는 dto는 해당 API 폴더에 dto 폴더를 새로 두어, 재사용 하는 dto class 를 따로 정의할 것
  - Request DTO
    - "요청" 에 관한 책임
    - 정적 Validation 필요 (class-validator 를 활용)
    - 파일 네이밍 예시, Param Query 를 같이사용할 경우 다음 과 같이 이름으로 구분
      - `{module 이름}{메소드 이름}{ReqDto}`
      - `{module 이름}{메소드 이름}{ReqParamDto}`
      - `{module 이름}{메소드 이름}{ReqQueryDto}`
        - export class UserSignUpReqDto
  - Response DTO
    - "응답" 에 관한 책임
    - 주로 Get 을 활용한 Http API 에서 어떠한 return 값을 받는지 전부 정의해야합니다.
    - 파일 네이밍 예시
      - `{module 이름}{메소드 이름}{ResDto}`
        - export class UserLoginResDto

### Application

- 실제 비즈니스 레이어 구현체
  - service 를 주로 구현한다.
  - 실제 비즈니스 로직이 이루어 지는 곳
  - 유닛 테스트 (선택사항)
    - 외부 의존성 없이 테스트가 쉽게 가능하다.
    - DI 된 class는 mocking 하여 테스트를 진행한다.

### Domain

- 주로 변경되지 않는다.
  - 코어한 로직, 변경될 경우 다른 레이어 에도 전부 영향이 있다.
- 모든 레이어가 해당 Domain 레이어의 의존성을 갖고 있다.

### Infrastructure (Infra)

- 외부와 연결되어있는 레이어 및 구현체입니다.
- 소셜 로그인, 외부 연동 API, 등 해당 서버 애플리케이션에서만 이루어지지 않고 타 API 를 사용할때 주로 구현체로 사용합니다.
  - 예를들어 nice-pay 의 결제 완료에 대한 API 를 사용하고자 할때, 해당 레이어에 구현하여 따로 주입받습니다.
- 주입받은 Repository 뿐만 아닌 custom 한 Repository 등, 외부 의존성이 존재하는 경우 해당 레이어에 구현합니다.

### interface

- 해당 모듈에서 사용하는 interface 및 type 등을 정의합니다.
- infrastructure 레이어에서 사용하는 추상화된 interface 등 도 해당 레이어에 정의해서 사용합니다.
- infra 에서 추상화된 interface 혹은 enum 값 들을 interface 레이어에 정의합니다.

### 폴더 구조 예시

- 아래는 주문 관련한 도메인의 예시 폴더 구조입니다.
  ```
  +---order
  |   |   order.module.ts
  |   |
  |   +---api
  |   |      +---dto
  |   |      |
  |   |          order.view.dto.ts
  |   |      order.controller.ts
  |   |      order.req.dto.ts
  |   |      order.res.dto.ts
  |   |
  |   +---application
  |   |      order.service.spec.ts
  |   |      order.service.ts
  |   |
  |   +---domain
  |   |      order.ts
  |   |      order.coupon.validator.ts
  |   |
  |   \---infra
  |   |       order.repository.ts
  |   |       order.complete.nice-pay.http.ts
  |   |       order.cancel.nice-pay.http.ts
  |   \---interface
  |   |       order.ts
  |   |       order.nice-pay.ts
  ```

# 인수인계 참고사항

## Process manager

1. pm2 설치

```
npm i -g pm2
```

2. 애플리케이션 실행

프로덕션 실행 전에는 반드시 빌드가 완료되어 있어야 합니다.

```
npm run build
```

```
pm2 start npm --name "backend" -- run start:prod
```

- 프로세스 확인

```aiignore
pm2 list # 현재 실행 프로세스 보기
pm2 stop {id} # 프로세스 중지
pm2 start {id} # 프로세스 시작
pm2 restart {id} # 프로세스 재시작
```

- 프로세스 로그 보기

```
pm2 log # 파일 경로 .pm2/logs
```

## KST

- 해당 프로젝트의 date 관련 값은 **전부 KST(UTC+09:00) 기준으로 처리**합니다.
  - 개발 및 데이터 시간 확인 시 KST 기준으로 확인해 주세요.
  - 메인 DB 세션 타임존도 `+09:00`으로 설정되어 있습니다.
  - 일부 만료일/예약일 계산은 `dayjs.tz('Asia/Seoul')` 기준으로 처리합니다.
  - 시간 표기 방식은 프론트엔드에서 처리합니다.

## 발송

- 이팝콘 프리미엄 프로젝트에서 "쿠폰 발송" 은 예약된 시간에 따라 배치로 전송하도록 구성되어 있습니다.
  - 참고 파일 : /src/delivery/delivery.batch.schedule.ts

### 발송 프로세스

- 참고 파일 : /src/delivery/application/delivery.batch.service.ts
- 메서드 이름 : issueAndSend

1. order_delivery Table 에 저장되어 있는 "발송 확정"(WAIT) 값으로 설정된 쿠폰 발송 데이터들을 전부 불러옵니다.
2. 대치 문자, 발송 내용 템플릿 등 전송에 필요한 내용들을 각 발송 수단에 따라 설정합니다.
3. 알림톡, SMS, 이메일에 따라 모듈을 다르게 전송합니다.
   2.1 발송 관련하여 다르게 진행하고 싶을 경우 각 모듈 호출 관련하여 수정하시면 됩니다.
   - 알림톡 class 이름 : DeliveryAlimTalkInfoBankHttp
   - SMS class 이름 : SmsGemtekSend
   - 이메일 class 이름 MailSendHiworks
4. 전송에 실패 유무 및 history 를 delivery_send_history table 에 저장합니다.
