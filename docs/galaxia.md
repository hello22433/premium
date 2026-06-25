✦ 갤럭시아 연동 코드에서 보이는 `cpn`과 `dept`는 상품의 유형(Type)에 따른 처리 방식의 차이입니다.코드를 분석해보면 다음과 같이 구분됩니다.용어의 의미 \* `cpn` (Coupon): 일반적인 모바일 쿠폰 (편의점, 카페 교환권 등) \* `dept` (Department Store): 백화점 상품권 (주로 모바일 백화점 상품권) 2. 코드에서의 구분 기준 (ExternBatchService.java, ExternPinService.java) ExternBatchService나 ExternPinService에서 갤럭시아 로직을 호출할 때, giftKind라는 파라미터나 URL 교체 로직을 통해 둘을 구분합니다.
1 // ExternBatchService.java (배치 로직)
2 String modelName = pinInfo.getModelName();
3 int giftKind = 0;
4
5 // 모델명(상품명)에 "(백화점)"이 포함되어 있으면 dept 모드로 동작
6 if (modelName.contains("(백화점)")) {
7 giftKind = 1; // 1이면 dept, 0이면 cpn
8 }
즉, 상품명에 "(백화점)"이라는 텍스트가 들어가 있으면 백화점 상품권(dept) 로직을 탑니다. 3. API 호출 시 차이점 (GalaxiaManagerImpl.java) GalaxiaManagerImpl 내부에서 cpn과 dept는 URL과 파라미터 구성에서 차이를 보입니다.
A. URL 구조 변경
API URL의 {type} 부분이 동적으로 변경됩니다. \* 일반 쿠폰 (`cpn`): .../interface/mkt/enmad/cpn/... \* 백화점 상품권 (`dept`): .../interface/mkt/enmad/dept/...
1 // GalaxiaManagerImpl.java
2 url = url.replaceAll("\\{type\\}", (giftKind != 0) ? "dept" : "cpn");
B. 발급(Get) 시 파라미터 차이 \* `order-number` (주문번호):
​ \* cpn: tr*id (거래 ID) 그대로 사용 (예: ga_1234_5678)
​ \* dept: tr_id에서 언더바(`*`)를 제거해서 사용 (예: ga12345678)
\* `faceValue` (액면가):
​     \* cpn: 파라미터로 보내지 않음 (상품코드에 금액 정보가 포함된 것으로 추정)
​     \* dept: 필수 파라미터. &faceValue=... 형태로 금액을 명시해서 보냄.
\* 수신자 번호 (`recipient`):
​     \* cpn: 고객의 실제 핸드폰 번호 사용
​     \* dept: `01000000000`으로 고정해서 보냄 (백화점 상품권은 수신자 번호를 특정하지 않거나, 보안상 이유로 더미 번호를 보내는 것으로 보임)

C. 조회(Check) / 취소(Cancel) 시 파라미터 차이 \* `order-number` / `tr_id`: 발급 때와 마찬가지로 백화점 상품권(dept)인 경우 언더바(\_)를 제거하고 암호화하거나 전송합니다.

​ 4. 요약 정리┌───────────────┬──────────────────────────┬─────────────────────────────┐

│ 구분 │ 일반 쿠폰 (cpn) │ 백화점 상품권 (dept) │

├───────────────┼──────────────────────────┼─────────────────────────────┤

│ 판별 기준 │ 기본값 │ 상품명에 (백화점) 포함 시 │

│ API URL │ .../enmad/cpn/... │ .../enmad/dept/... │

│ 주문번호 │ ga_1234_5678 (언더바 유지) │ ga12345678 (언더바 제거) │

│ 금액 파라미터 │ 전송 안 함 │ &faceValue=5000 (필수 전송) │

│ 수신자 번호 │ 실제 고객 번호 │ 01000000000 (고정값) │

└───────────────┴──────────────────────────┴─────────────────────────────┘ 따라서 갤럭시아 연동에 문제가 발생했다면, 해당 상품이 백화점 상품권인지 아닌지를 먼저 확인하고, 그에 따라 파라미터가(특히 주문번호 포맷이나 금액) 올바르게 넘어가는지 디버깅해야 합니다.
