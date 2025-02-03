import { ApiProperty } from '@nestjs/swagger';

export class GetListResDto {
  @ApiProperty({
    description: '전체 페이지 수',
  })
  totalPage: number;

  @ApiProperty({
    description: '전체 페이지 수',
  })
  totalCount: number;

  @ApiProperty({
    description: '현재 페이지',
  })
  currentPage: number;
}
