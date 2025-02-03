import { ApiProperty } from '@nestjs/swagger';

export class MessageArchiveViewDto {
  @ApiProperty({
    description: '문자 보관함 id',
  })
  id: number;

  @ApiProperty({
    description: '문자 보관함 제목',
  })
  title: string;

  @ApiProperty({
    description: '문자 보관함 내용',
  })
  content: string;
}
