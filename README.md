
# .env 
* .env.example 및 세팅 내용 참고 


## Installation

```bash
$ npm install
```

## Running the app

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode npm run build 후 실행해야 합니다. 
$ npm run start:prod
```

# Architecture
- 기본적으로 레이어드 아키텍처를 참고하여 다음과 같은 규칙을 차용하고자 합니다.
- 각 레이어에 따라 책임과 역할을 구분하여 사용해 주세요.
----
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
