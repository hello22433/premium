import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class DownloadWithPasswordReqDto {
  @ApiProperty({
    description: '비밀번호',
    example: 'mypassword123',
  })
  @IsNotEmpty()
  @IsString()
  password: string;

  @ApiProperty({
    description: '다운로드 사유',
    example: '월간 보고서 작성을 위한 데이터 다운로드',
  })
  @IsNotEmpty()
  @IsString()
  downloadReason: string;
}
