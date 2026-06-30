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

  /**
   * 객체 메타데이터에서 진짜 원본 파일명을 읽는다(없으면 null). HeadObject 1회.
   */
  headOriginalName(key: string): Promise<string | null>;

  /**
   * 외부 URL의 이미지를 S3로 복사
   * @param imageUrl 외부 이미지 URL
   * @returns S3에 저장된 이미지 URL
   */
  copyImageFromUrl(imageUrl: string, safeIp: string): Promise<IFileUploadFileReturn>;
}
