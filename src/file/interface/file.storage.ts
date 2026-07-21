export type IFileUploadFileReturn = {
  originalName: string;
  url: string;
};

export interface IFileStorage {
  uploadImageFile(file: Express.Multer.File): Promise<IFileUploadFileReturn>;

  uploadFile(file: Express.Multer.File): Promise<IFileUploadFileReturn>;

  /**
   * 비공개(private) 저장. 백엔드가 자격증명으로 GetObject 해서 스트리밍하는 파일용.
   * public-read 를 쓰지 않고, 키 추측을 막기 위해 무작위(UUID) key 를 사용한다.
   * ownerId 를 주면 `private/{ownerId}/...` 로 저장해 "누가 올렸는지" 를 key 에 귀속시킨다
   * (다운로드 프록시가 소유자 검증으로 타인 객체 우회 read 를 차단할 수 있게).
   * 진짜 원본 파일명은 객체 메타데이터(originalname)에 verbatim 보존한다(key 는 sanitize 됨).
   */
  uploadPrivateFile(file: Express.Multer.File, ownerId?: number): Promise<IFileUploadFileReturn>;

  uploadImageFileWithBuffer(buffer: Buffer, fileName: string, originalName: string): Promise<IFileUploadFileReturn>;

  downloadFileToLocalWithPath(path: string, fileTitle: string, downloadPath: string): Promise<string>;

  /** 주어진 S3 key 의 객체를 메모리 버퍼로 읽는다(로컬 파일 없이). 파싱 등 서버 내 처리용. */
  getFileBuffer(key: string): Promise<Buffer>;

  /**
   * 객체 메타데이터에서 진짜 원본 파일명을 읽는다(없으면 null). HeadObject 1회.
   */
  headOriginalName(key: string): Promise<string | null>;

  /**
   * 객체 크기(바이트)를 본문 다운로드 없이 읽는다(못 구하면 null). HeadObject 1회.
   * 대용량/압축폭탄을 getFileBuffer(본문 적재) 전에 거르는 용도.
   */
  headContentLength(key: string): Promise<number | null>;

  /**
   * 주어진 URL 이 우리 S3 버킷의 객체 URL 인지(host 기준). 다운로드 프록시가
   * 외부 host URL 의 pathname 을 우리 key 로 오인해 read 하는 것을 막는 데 쓴다.
   */
  isOwnStorageUrl(fileUrl: string): boolean;

  /**
   * 외부 URL의 이미지를 S3로 복사
   * @param imageUrl 외부 이미지 URL
   * @returns S3에 저장된 이미지 URL
   */
  copyImageFromUrl(imageUrl: string, safeIp: string): Promise<IFileUploadFileReturn>;
}
