# [프론트 요청] 주문접수 첨부 — 비공개 업로드 + 다운로드 프록시 전환

작성일: 2026-06-29 / 대상 레포: epopkon-premium-front / 관련 화면: 주문접수 상세(`OrderReceiptDetailPage`)

## 배경 (왜)

주문접수 첨부 엑셀이 **공용 업로드(`POST /file/upload`)** 로 저장되는데, 이건 **ACL public-read + 시각기반 key** 라서:
- 링크만 알면 인증 없이 누구나 다운로드 가능(민감한 주문/고객 정보 노출)
- 다운로드 시 파일명에 난수(업로드 시각) 접두사가 붙음

백엔드를 **비공개(private) 저장 + 다운로드 프록시** 로 바꿨습니다. 프론트도 그에 맞춰 **업로드 엔드포인트 교체 + 다운로드를 프록시 경유로** 변경해 주세요. 이걸로 보안과 다운로드 파일명이 동시에 해결됩니다.

> 이번 범위는 **주문접수만**입니다. (문서함/QnA/문의는 후속)

---

## 백엔드 변경 사항 (이미 반영 완료)

### 1) 신규 업로드 엔드포인트 — `POST /file/upload-private`
- 기존 `POST /file/upload` 와 **요청/응답 형식 완전히 동일** (multipart/form-data, key=`file`, Bearer 필요, 응답 `{ url: string }`).
- 차이: ACL private + 무작위 key 로 저장. 반환 `url` 은 `https://<bucket>.s3.amazonaws.com/private/...` 이며 **직접 접근 불가**(이 URL을 `<img>`/`<a href>` 로 열면 AccessDenied).

### 2) 신규 다운로드 프록시 — `GET /order-receipt/{id}/file/download?fileUrl={첨부url}`
- Bearer 필요, 응답은 **파일 스트림(blob)**.
- 권한: 운영/최고관리자=전체, 기업관리자=**본인 문서만**(아니면 403).
- `fileUrl` 이 해당 주문접수의 첨부가 아니면 400(IDOR 차단).
- 성공 시 헤더: `Content-Disposition: attachment; filename="..."; filename*=UTF-8''<원본명>` → **원본 파일명**으로 내려갑니다.

---

## 프론트 변경 요청

### A. 업로드 호출 교체 (`OrderReceiptDetailPage.tsx`, 2곳)
주문접수 첨부 업로드를 `postFileUpload` → **`postFileUploadPrivate`** 로 교체.
- 대상: `handleSubmit`(신규 등록), `handleSave`(수정 시 신규 첨부) 안의 `postFileUpload(file)` 2곳.
- 응답 형태 동일(`res.data.result.url`)하므로 **호출 함수명만 교체**하면 됩니다. 등록/수정 시 `filePath` 배열에 담아 보내는 흐름은 변경 없음.

신규 api 모듈(기존 `postFileUpload.ts` 와 동일, URL만 다름):
```ts
// src/apis/postFileUploadPrivate.ts
export const postFileUploadPrivate = async (file: File) => {
  const accessToken = getCookie(COOKIE_KEYS.TOKEN_KEY[SERVICE_TYPE.EPOPKON].ACCESS)
  const formData = new FormData()
  formData.append('file', file)
  return axios(`${API.ENDPOINT.EPOPKON_API}/file/upload-private`, {
    method: 'POST',
    data: formData,
    headers: { 'Content-Type': 'multipart/form-data', Authorization: `Bearer ${accessToken}` },
  })
}
```

### B. 다운로드를 프록시 경유로 (`OrderReceiptDetailPage.tsx`, 첨부 링크 2곳)
현재 첨부는 `<a href={fileUrl} target="_blank">{getDisplayFileName(fileUrl)}</a>` 로 **S3 URL 직접 오픈**입니다. private 전환 후엔 이 방식이 동작하지 않습니다(직접 접근 불가). **프록시 호출 → blob 저장** 으로 바꿔주세요.
- 대상: 편집모드 `existingFiles.map(...)` 링크 + 읽기모드 `data.filePathList.map(...)` 링크 (2곳).
- 저장 파일명은 **기존 `getDisplayFileName(fileUrl)` 을 그대로** 쓰면 됩니다(이미 난수 접두사를 떼어 원본명을 만드는 함수. 백엔드 Content-Disposition 도 동일 원본명).

신규 api 모듈(공유리스트 `getSharedListFileDownload.ts` 패턴 동일):
```ts
// src/apis/order-receipt/getOrderReceiptFileDownload.ts
export const getOrderReceiptFileDownload = async (id: number, fileUrl: string) => {
  return request<AxiosResponse<Blob>>({
    url: `${API.PROXY.EPOPKON_API}/order-receipt/${id}/file/download`,
    method: Methods.GET,
    params: { fileUrl },
    responseType: 'blob',
  })
}
```

다운로드 핸들러 + 링크 → 버튼:
```tsx
const handleDownloadFile = useCallback(async (fileUrl: string) => {
  if (!selectedId) return
  try {
    const response = await getOrderReceiptFileDownload(selectedId, fileUrl)
    FileSaver.saveAs(response.data, getDisplayFileName(fileUrl)) // FileSaver는 이미 의존성(fileHelper에서 사용 중)
  } catch {
    alert('파일 다운로드에 실패했습니다.')
  }
}, [selectedId])

// 링크 대신:
<button type="button" onClick={() => handleDownloadFile(fileUrl)}
        className="btn btn-link p-0 align-baseline text-white text-decoration-underline me-1">
  {getDisplayFileName(fileUrl)}
</button>
```

> 참고: `request` 유틸은 blob 응답일 때 전체 AxiosResponse 를 반환합니다(`response.data` = Blob). 공유리스트 다운로드(`useSharedListFileDownloadMutation`)와 동일.
> 헤더에서 파일명을 뽑고 싶다면 주의: 현재 `FileHelper.getFileNameByHeader` 는 `filename="..."`(따옴표) 케이스를 못 읽습니다. **`getDisplayFileName(fileUrl)` 사용을 권장.**

### C. 기존 단위 테스트 갱신 (5개)
`tests/unit/order/receipt/OrderReceiptDetailPage.*.test.tsx` 들이 `@/apis/postFileUpload` 를 mock/assert 합니다. → **`postFileUploadPrivate` 로 갱신** 필요.
- 전 파일: `vi.mock('@/apis/postFileUpload', ...)` → `vi.mock('@/apis/postFileUploadPrivate', ...)`
- `create.test.tsx`(정상 등록), `edit-corporate.test.tsx`(정상 저장): `postFileUpload` 호출 단언 → `postFileUploadPrivate` 로 변경.

---

## 호환/주의

- **기존에 올라간 첨부(과거 public URL)** 도 프록시 `GET /order-receipt/{id}/file/download` 로 다운로드됩니다(백엔드가 구 key 호환). → **다운로드는 신/구 구분 없이 전부 프록시 경유로 통일**하면 됩니다.
- 기존 public 객체 자체의 접근 차단(S3 ACL 일괄 변경)은 백엔드/운영 후속이라 프론트와 무관합니다. 프론트는 `href` 직접열기만 제거하면 됩니다.
- 영향 화면은 **주문접수 상세뿐**입니다. 다른 첨부(이미지 등)는 변경 없음.

## 체크리스트
- [ ] `postFileUploadPrivate` api 추가, 주문접수 업로드 2곳 교체
- [ ] `getOrderReceiptFileDownload` api 추가, 첨부 링크 2곳 → 프록시 다운로드 버튼
- [ ] 단위 테스트 5개 `postFileUploadPrivate` 로 갱신
- [ ] 동작 확인: 등록→다운로드 파일명이 원본명(난수 없음), 타 기업계정 접근 차단
