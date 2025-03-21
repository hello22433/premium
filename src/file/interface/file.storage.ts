export type IFileUploadFileReturn = {
  originalName: string;
  url: string;
};

export interface IFileStorage {
  uploadImageFile(file: Express.Multer.File): Promise<IFileUploadFileReturn>;

  uploadImageFileWithBuffer(buffer: Buffer, fileName: string, originalName: string): Promise<IFileUploadFileReturn>;

  downloadFileToLocal(downloadPath: string): Promise<string>;

  downloadFileToLocalWithPath(path: string, fileTitle: string, downloadPath: string): Promise<string>;
}
