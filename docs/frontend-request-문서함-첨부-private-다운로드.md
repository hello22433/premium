# [프론트 요청] 문서함(user-drive) 첨부 — 비공개 업로드 + 다운로드 프록시

작성일: 2026-07-29 / 대상 레포: epopkon-premium-front / 관련 화면: 문서함(발신 작성/수신 상세)

## 배경
주문접수와 동일한 이유 — 문서함 첨부도 공용 `/file/upload`(public-read + 시각기반 key)로 저장돼 링크만 알면 인증 없이 받아지고, 다운로드 파일명에 난수 접두사가 붙습니다. 백엔드를 **비공개(private) 저장 + 다운로드 프록시 + 원본명 보존**으로 바꿨습니다. (주문접수 PR #538과 같은 패턴)

## 백엔드 변경 (이미 반영)
- **업로드**: 기존 `POST /file/upload-private`(주문접수에서 추가된 공용 엔드포인트) 그대로 사용. 요청/응답은 `/file/upload`와 동일(`{ url }`), ACL private + `private/{업로더id}/...` 저장.
- **다운로드 프록시**: `GET /user-drive/{id}/file/download?fileUrl={첨부url}` (Bearer, blob).
  - 권한: 운영/최고관리자=전체, **기업관리자=본인이 수신자인 문서(비DRAFT)만**.
  - 응답 헤더 `Content-Disposition`에 **원본 파일명**(RFC5987).
- **상세조회 응답**: `files: [{ url, name }]` 추가(`name`=진짜 원본명). `filePathList: string[]`는 **하위호환으로 유지**.

## 프론트 변경 요청

> **현행(FE 코드 확인 결과, 2026-07-29):** 문서함 화면은 단일 컴포넌트 `src/features/customer-service/document/DocumentDetailPage.tsx`(상세=작성=수정 겸용). 첨부 업로드는 `postFileUpload`가 아니라 **`postFileImage`(`POST /file/image`, 폼필드 `imageFile`, 응답 `data.result.url`, ACL public)** 를 씀. 다운로드는 raw `<a href={fileUrl}>`. `getDisplayFileName` 로직은 이 파일에 인라인 복붙되어 있음.
> **가장 빠른 길:** 이미 완성된 주문접수 화면 `src/features/order/receipt/OrderReceiptDetailPage.tsx` + `src/apis/order-receipt/getOrderReceiptFileDownload.ts` 를 **그대로 본떠** 옮기면 됩니다(같은 패턴).

### A. 업로드 호출 교체 (문서 발신/작성 화면)
`DocumentDetailPage.tsx` 의 첨부 업로드를 **`postFileImage` → `postFileUploadPrivate`(`src/apis/postFileUploadPrivate.ts`, 이미 존재)** 로 교체.
- ⚠️ 두 함수는 **드롭인 치환이 아님**: 폼필드(`imageFile`→`file`)와 응답 shape(`data.result.url` → **`data.url`**)가 다름. URL 추출부를 주문접수(`OrderReceiptDetailPage.tsx`)가 `postFileUploadPrivate` 응답을 파싱하는 방식과 동일하게 맞출 것.

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

## 호환/주의
- 과거 첨부(공개 `file/` URL)도 프록시로 다운로드됩니다(백엔드 레거시 `file/` 허용). 다운로드는 신/구 구분 없이 프록시로 통일.
- 첨부 등록은 **최대 10개**(백엔드 `@ArrayMaxSize(10)`).
- 영향 화면은 문서함(발신 작성 + 수신 상세)뿐.

## 체크리스트
- [ ] 업로드 `postFileUploadPrivate`로 교체
- [ ] `getUserDriveFileDownload` 추가, 첨부 링크 → 프록시 blob 다운로드
- [ ] 표시·다운로드명 `files[].name` 사용
- [ ] 단위테스트 갱신
- [ ] 확인: 수신 기업계정이 본인 수신 문서 첨부를 원본명으로 받음 / private URL 직접접근 403
