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
   * (예: 공유 상품리스트 — 직접 객체 접근 표면 제거)
   */
  uploadPrivateFile(file: Express.Multer.File): Promise<IFileUploadFileReturn>;

  uploadImageFileWithBuffer(buffer: Buffer, fileName: string, originalName: string): Promise<IFileUploadFileReturn>;

  downloadFileToLocalWithPath(path: string, fileTitle: string, downloadPath: string): Promise<string>;

  /**
   * 외부 URL의 이미지를 S3로 복사
   * @param imageUrl 외부 이미지 URL
   * @returns S3에 저장된 이미지 URL
   */
  copyImageFromUrl(imageUrl: string, safeIp: string): Promise<IFileUploadFileReturn>;
}
