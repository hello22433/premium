import { ApiProperty } from '@nestjs/swagger';

export class ProductHistoryViewDto {
  @ApiProperty({
    description: 'product history id',
  })
  id: number;

  @ApiProperty({
    description: '변경자, 없을시 삭제 회원으로 출력됨',
  })
  userName: string;

  @ApiProperty({
    description: 'product 변경 column',
  })
  key: string;

  @ApiProperty({
    description: '변경 키 이름',
  })
  keyName: string;

  @ApiProperty({
    description: '변경 이전 변수',
  })
  beforeValue: string | null;

  @ApiProperty({
    description: '변경 후 변수',
  })
  afterValue: string | null;

  @ApiProperty({
    description: '변경 일자 ex) yyyy-MM-ddTHH:mm:ss',
  })
  createdAt: string;
}
