# [프론트 요청] 문서함(user-drive) 첨부 — 비공개 업로드 + 다운로드 프록시

작성일: 2026-07-29 / 대상 레포: epopkon-premium-front / 관련 화면: 문서함(발신 작성/수신 상세)

> **2026-08-18 재확인** — 아래 "현행 FE" 내용을 배포본(`upstream/develop`, 그날 fetch)으로 다시 확인했다.
> 관측에는 날짜가 붙는다: 7-29 관측 당시와 **결론은 같지만** 그 사이 프론트가 96커밋 움직였다.
>
> | 확인 | 배포본 상태 |
> |---|---|
> | 문서함 다운로드 API | 없음(`src/apis/user-drive/` 에 download 파일 없음). 주문접수만 있다 |
> | 업로드 채널 | **둘이다** (아래 표 참조). BE 는 둘 다 레거시로 허용하므로 **BE 단독 배포가 무해**하다 |
> | 상세 응답 | `data.filePathList` 만 사용. `files` 미사용 → 필드 추가 안전 |
> | 응답 순회·스프레드·런타임 스키마 검증 | 없음 → 필드 추가로 안 깨진다 |
> | PUT `status` | 폼 select 로 항상 전송(기본 REGISTER) → 조치 불필요 |
> | 첨부 개수 가드 | 여전히 없음(`handleFileChange`) → 아래 요청 유효 |

## 배경
주문접수와 동일한 이유 — 문서함 첨부도 공용 `/file/upload`(public-read + 시각기반 key)로 저장돼 링크만 알면 인증 없이 받아지고, 다운로드 파일명에 난수 접두사가 붙습니다. 백엔드를 **비공개(private) 저장 + 다운로드 프록시 + 원본명 보존**으로 바꿨습니다. (주문접수 PR #538과 같은 패턴)

## 백엔드 변경 (이미 반영)
- **업로드**: 기존 `POST /file/upload-private`(주문접수에서 추가된 공용 엔드포인트) 그대로 사용. 응답 DTO는 `/file/upload`·`/file/image`와 동일(`{ url }` → 전역 인터셉터가 감싸서 최종 **`data.result.url`**), ACL private + `private/{업로더id}/...` 저장.
- **다운로드 프록시**: `GET /user-drive/{id}/file/download?fileUrl={첨부url}` (Bearer, blob).
  - 권한: 운영/최고관리자=전체, **기업관리자=본인이 수신자인 문서(비DRAFT)만**.
  - 응답 헤더 `Content-Disposition`에 **원본 파일명**(RFC5987).
- **상세조회 응답**: `files: [{ url, name }]` 추가(`name`=진짜 원본명). `filePathList: string[]`는 **하위호환으로 유지**.

## 프론트 변경 요청

> **현행(FE 코드 확인 결과, 2026-07-29):** 문서함 화면은 단일 컴포넌트 `src/features/customer-service/document/DocumentDetailPage.tsx`(상세=작성=수정 겸용). 첨부 업로드는 `postFileUpload`가 아니라 **`postFileImage`(`POST /file/image`, 폼필드 `imageFile`, 응답 `data.result.url`, ACL public)** 를 씀. 다운로드는 raw `<a href={fileUrl}>`. `getDisplayFileName` 로직은 이 파일에 인라인 복붙되어 있음.
> **가장 빠른 길:** 이미 완성된 주문접수 화면 `src/features/order/receipt/OrderReceiptDetailPage.tsx` + `src/apis/order-receipt/getOrderReceiptFileDownload.ts` 를 **그대로 본떠** 옮기면 됩니다(같은 패턴).

### A. 업로드 호출 교체 (문서 발신/작성 화면)
`DocumentDetailPage.tsx` 의 첨부 업로드를 **`postFileImage` → `postFileUploadPrivate`(`src/apis/postFileUploadPrivate.ts`, 이미 존재)** 로 교체.
- ⚠️ 차이는 **폼필드뿐**: `imageFile` → **`file`**. 응답 shape은 **동일**합니다 — 전역 `TransformResInterceptor`가 모든 응답을 `{ result }`로 감싸므로 두 API 다 **`data.result.url`** 로 꺼냅니다(주문접수 FE도 동일). 즉 URL 추출부(`.data.result.url`)는 그대로 두고 업로드 함수와 폼필드만 바꾸면 됩니다.
- ownerId 는 **토큰에서 가져갑니다**(`file.controller.ts:119` 가 `user.id` 를 씀). 프론트가 보낼 값이 없습니다.

#### 부수 효과 — 이 교체로 문서함 화면의 제약 두 개가 풀립니다

| | 현재 `/file/image` | 교체 후 `/file/upload-private` |
|---|---|---|
| 파일 크기 상한 | 10MB | **20MB** |
| 파일 종류 | **이미지만** (`mime.startsWith('image/')` 아니면 400 `NO_IMAGE_FILE_TYPE`) | 제한 없음 |

지금은 문서함 화면에서 **손으로** PDF·한글·엑셀을 고르면 업로드가 실패합니다.
`<input type="file" multiple>` 에 `accept` 가 없어 고를 수는 있고(`DocumentDetailPage.tsx:368-369`)
올리는 순간 실패 건수로 잡힙니다(`:136-141`). 이번 교체로 같이 풀립니다.

> ⚠️ **주의 — 그렇다고 "문서함에 PDF 가 안 붙는다" 는 아닙니다.** 정산 화면에서 만든 리포트 PDF 가
> 다른 채널로 이미 들어오고 있습니다(아래 F 항목). 채널이 둘이라는 걸 모르고 보면 오판합니다.

### B. 다운로드를 프록시 경유로 (문서 상세 화면)
첨부를 `<a href={fileUrl}>` 직접 오픈 → **프록시 blob 다운로드**로 교체. private라 직접 URL 접근은 403입니다.
```ts
// src/apis/user-drive/getUserDriveFileDownload.ts  (order-receipt 것과 동일 패턴)
export const getUserDriveFileDownload = async (id: number, fileUrl: string) =>
  request<AxiosResponse<Blob>>({
    url: `${API.PROXY.EPOPKON_API}/user-drive/${id}/file/download`,
    method: Methods.GET,
    params: { fileUrl },
    responseType: 'blob',
  })
```
```tsx
const handleDownload = useCallback(async (file: { url: string; name: string }) => {
  const res = await getUserDriveFileDownload(driveId, file.url)
  FileSaver.saveAs(res.data, file.name)   // ← 상세조회의 files[].name 사용(진짜 원본명)
}, [driveId])
```

### C. 표시·다운로드명은 `files[].name` 사용
기존 `filePathList` + `getDisplayFileName(key파싱)` 대신 **상세조회 응답의 `files`**를 써서 뱃지 표시·다운로드명 모두 `name`으로 통일(화면=다운로드 일관). `filePathList`는 남아 있으나 신규 화면은 `files` 사용.

### D. 단위테스트 갱신
`DocumentDetailPage` 테스트가 `postFileImage`를 mock/assert 한다면 `postFileUploadPrivate`로 갱신.

### ⭐ F. 정산 화면의 리포트 PDF 도 같은 전환 (2026-08-18 추가 — 원래 요청서에 빠져 있던 채널)

**문서함으로 첨부가 들어오는 입구가 둘입니다.** 처음 요청서는 하나만 다뤘습니다.

| 화면 | 업로드 API | S3 접두사 | 올라가는 것 |
|---|---|---|---|
| 고객센터 > 문서함 (`DocumentDetailPage`) | `POST /file/image` | `image/` | 사용자가 고른 이미지 |
| **정산 > 고객사별정산관리** (`DocumentModal`) | `POST /file/pdf` | `file/` | **프론트가 생성한 리포트 PDF** |

두 번째 채널이 더 민감합니다. 올라가는 PDF 세 종류에 이런 게 들어갑니다.

| PDF | 담기는 것 | 근거 |
|---|---|---|
| 발송완료리포트 | **수신자 전화번호가 행마다** | `DeliveryCompleteReportFormatter.ts:154` (`phoneNumber: item.deliveryTarget`) |
| 거래명세서 | 사업자등록번호 · 대표자명 · 공급가액 · 합계 | `PdfStateManager.ts:345,350,370,374` |
| 파기확약서 | 파기 확약 내용 | 같은 formatter |

**이게 `public-read` 로 올라갑니다.** key 는 UUID(32hex)라 주소를 찍어서 찾을 수는 없지만,
그 링크는 문서함 상세 응답으로 **고객사에게 의도적으로 전달**됩니다. 고객사가 URL 을 한 번 넘기면
인증 없이 누구나 받습니다 — 링크 자체가 권한입니다.

#### 바꿀 곳은 두 줄입니다

```
DocumentModal.tsx (3곳)
   → PdfReportManager.upload  ─┐
   → PdfStateManager.upload   ─┴→ postFilePdf   ← 여기를 postFileUploadPrivate 로
                                  PdfReportManager.ts:1137 · PdfStateManager.ts:80
```

`postFilePdf` 를 쓰는 곳은 이 둘뿐이고(배포본 전수 확인), 호출 경로도 `DocumentModal.tsx` 하나뿐입니다.
이 PDF 들은 전부 문서함으로만 흘러갑니다. **백엔드는 바꿀 게 없습니다** —
`/file/upload-private` 는 이미 있고, 쓰기 검증(`ownerId === 등록자`)·다운로드 권한(`ownerId === 발신자`)
둘 다 통과합니다. 다운로드는 B 의 프록시가 그대로 처리합니다.

#### 대가 두 가지

| 대가 | 설명 |
|---|---|
| **PDF 강제 가드가 사라집니다** | `/file/pdf` 는 `application/pdf` 가 아니면 400 인데 `/file/upload-private` 는 종류 제한이 없습니다. 다만 이 PDF 는 **프론트가 직접 만들어** 올리므로 사용자가 종류를 고르는 게 아닙니다 |
| **정산 화면 회귀 필요** | 발송완료리포트 · 거래명세서 · 파기확약서 3종 전부 |

부수 효과로 상한이 10MB → 20MB 로 늘어납니다(리포트가 커져도 안전).

## 호환/주의
- 과거 첨부(공개 `image/` URL — 문서함 레거시는 `/file/image` 로 올라가 `image/` 접두사)도 프록시로 다운로드됩니다(백엔드 레거시 `image/`·`file/` 허용). 다운로드는 신/구 구분 없이 프록시로 통일.
- 첨부 개수는 **등록·수정 모두 최대 10개**(`@ArrayMaxSize(10)`, 초과 시 400 `"첨부파일은 최대 10개까지 등록할 수 있습니다."`). 한때 수정만 상한을 뺐었는데(상한 도입 전 초과 문서의 수정 락아웃 우려), 운영 실측에서 첨부 11개↑ 문서 0건·최대 2개로 확인돼 통일했습니다.
  - ⚠️ **FE `handleFileChange`에 개수 가드가 없습니다.** 11개 이상 선택하면 업로드까지 다 하고 저장에서 400이 납니다. **선택 시점에 10개 상한 + 안내**를 넣어 주세요(백엔드 상한 도입 전엔 무제한이었으므로 신규 제약입니다).
- 수정(PUT)은 `status`가 **필수**입니다(생략·`null` 시 400). 현행 `putUserDrive` 타입·`DocumentDetailPage` 모두 항상 보내고 있어 **조치 불필요** — 새 호출부를 만들 때만 유의.
- 영향 화면은 문서함(발신 작성 + 수신 상세)과 **정산 > 고객사별정산관리**(F 항목)입니다.

## ⭐ 배포 순서 — 한 번에 묶지 말고 이 순서로

업로드를 private 으로 바꾸는 순간부터 **직접 링크(`<a href>`)는 403** 이 됩니다. 그래서 순서가 곧 안전장치입니다.

| 순서 | 무엇 | 왜 이 순서가 안전한가 |
|---|---|---|
| **1** | **백엔드 배포** (이 PR) | 현행 화면이 그대로 동작합니다 — 업로드는 `image/`·`file/` 그대로, 다운로드는 직접 링크 그대로. 되돌릴 일이 없습니다 |
| **2** | **프론트 B + C + D** (다운로드 프록시 · 이름 · 개수 가드) | **단독으로 안전합니다.** 레거시 공개 첨부(`image/`·`file/`)도 프록시로 받아지므로, 업로드가 아직 공개여도 아무것도 안 깨집니다 |
| **3** | **프론트 A + F** (문서함 업로드 · 정산 리포트 업로드를 private 으로) | 2단계에서 **다운로드가 이미 프록시**라 깨질 수가 없습니다 |

⚠️ **A 나 F 를 2단계보다 먼저 내보내면 안 됩니다.** private 로 올라간 첨부를 직접 링크로 열려다 403 이 납니다.
반대 방향(2단계만 먼저)은 언제 나가도 안전합니다.

한 번에 묶어도 되지만, 묶으면 *"A 는 나갔는데 B 가 롤백"* 같은 상황에서 사고가 납니다.
**2와 3을 나누면 각 단계가 그 자체로 되돌릴 수 있습니다.**

## 체크리스트

**2단계 (단독 배포 가능)**
- [ ] `getUserDriveFileDownload` 추가, 첨부 링크 → 프록시 blob 다운로드 (B)
- [ ] 표시·다운로드명 `files[].name` 사용 (C)
- [ ] 첨부 선택 시점에 10개 상한 + 안내 (D)
- [ ] 확인: **기존(공개) 첨부**가 프록시로 원본명으로 받아짐

**3단계**
- [ ] 문서함 업로드 `postFileImage` → `postFileUploadPrivate` (A)
- [ ] 정산 리포트 업로드 `postFilePdf` → `postFileUploadPrivate` (F, 2곳)
- [ ] 단위테스트 갱신 (문서함 + 정산 3종)
- [ ] 확인: 수신 기업계정이 본인 수신 문서 첨부를 원본명으로 받음 / private URL 직접접근 403
- [ ] 확인: 정산 3종(발송완료리포트·거래명세서·파기확약서) 생성 → 첨부 → 수신측 다운로드
