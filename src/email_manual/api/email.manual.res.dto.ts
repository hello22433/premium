import { ApiProperty } from '@nestjs/swagger';

export class EmailManualGetResDto {
  @ApiProperty({
    description: 'ID',
  })
  id: number | null;

  @ApiProperty({
    description: '이메일 사용방법 내용',
  })
  content: string | null;

  @ApiProperty({
    description: '작성/수정한 사용자 ID',
  })
  userId: number | null;

  @ApiProperty({
    description: '작성/수정한 사용자 이메일',
  })
  userEmail: string | null;

  @ApiProperty({
    description: '수정일시',
  })
  updatedAt: Date | null;
}
