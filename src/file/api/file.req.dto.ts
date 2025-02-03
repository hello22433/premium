import { ApiProperty } from '@nestjs/swagger';

export class FileUploadImageReqDto {
  @ApiProperty({
    description: '업로드 하고자 하는 이미지 파일',
  })
  // =====================================================
  readonly imageFile: Express.Multer.File;
}
