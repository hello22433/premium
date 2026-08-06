# [프론트 요청] 문서함(user-drive) 첨부 — 비공개 업로드 + 다운로드 프록시

작성일: 2026-07-29 / 대상 레포: epopkon-premium-front / 관련 화면: 문서함(발신 작성/수신 상세)

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
- 과거 첨부(공개 `image/` URL — 문서함 레거시는 `/file/image` 로 올라가 `image/` 접두사)도 프록시로 다운로드됩니다(백엔드 레거시 `image/`·`file/` 허용). 다운로드는 신/구 구분 없이 프록시로 통일.
- 첨부 개수는 **등록·수정 모두 최대 10개**(`@ArrayMaxSize(10)`, 초과 시 400 `"첨부파일은 최대 10개까지 등록할 수 있습니다."`). 한때 수정만 상한을 뺐었는데(상한 도입 전 초과 문서의 수정 락아웃 우려), 운영 실측에서 첨부 11개↑ 문서 0건·최대 2개로 확인돼 통일했습니다.
  - ⚠️ **FE `handleFileChange`에 개수 가드가 없습니다.** 11개 이상 선택하면 업로드까지 다 하고 저장에서 400이 납니다. **선택 시점에 10개 상한 + 안내**를 넣어 주세요(백엔드 상한 도입 전엔 무제한이었으므로 신규 제약입니다).
- 수정(PUT)은 `status`가 **필수**입니다(생략·`null` 시 400). 현행 `putUserDrive` 타입·`DocumentDetailPage` 모두 항상 보내고 있어 **조치 불필요** — 새 호출부를 만들 때만 유의.
- 영향 화면은 문서함(발신 작성 + 수신 상세)뿐.

## 체크리스트
- [ ] 업로드 `postFileUploadPrivate`로 교체
- [ ] `getUserDriveFileDownload` 추가, 첨부 링크 → 프록시 blob 다운로드
- [ ] 표시·다운로드명 `files[].name` 사용
- [ ] 단위테스트 갱신
- [ ] 확인: 수신 기업계정이 본인 수신 문서 첨부를 원본명으로 받음 / private URL 직접접근 403
