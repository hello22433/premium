import { ApiProperty } from '@nestjs/swagger';

export class SaleTypeViewDto {
  @ApiProperty({
    description: 'id',
  })
  id: number;

  @ApiProperty({
    description: '코드',
  })
  code: string;

  @ApiProperty({
    description: '판매유형 name',
  })
  name: string;
}
