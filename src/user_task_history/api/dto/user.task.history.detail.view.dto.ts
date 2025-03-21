import { ApiProperty } from '@nestjs/swagger';

export class UserTaskHistoryDetailViewDto {
  @ApiProperty({
    description: 'user task history id',
  })
  id: number;

  @ApiProperty({
    description: '등록일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  registerAt: string;

  @ApiProperty({
    description: '유저 관리자 이름',
  })
  adminUserName: string | null;

  @ApiProperty({
    description: '내용',
  })
  content: string | null;
}
