export type IFileUploadFileReturn = {
  originalName: string;
  url: string;
};

export interface IFileStorage {
  uploadImageFile(file: Express.Multer.File): Promise<IFileUploadFileReturn>;

  uploadFile(file: Express.Multer.File): Promise<IFileUploadFileReturn>;

  uploadImageFileWithBuffer(buffer: Buffer, fileName: string, originalName: string): Promise<IFileUploadFileReturn>;

  downloadFileToLocal(downloadPath: string): Promise<string>;

  downloadFileToLocalWithPath(path: string, fileTitle: string, downloadPath: string): Promise<string>;

  /**
   * 외부 URL의 이미지를 S3로 복사
   * @param imageUrl 외부 이미지 URL
   * @returns S3에 저장된 이미지 URL
   */
  copyImageFromUrl(imageUrl: string, safeIp: string): Promise<IFileUploadFileReturn>;
}
