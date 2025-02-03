import { ApiProperty } from '@nestjs/swagger';

export class BrandDetailDto {
  @ApiProperty({
    description: 'brand.id',
  })
  id: number;

  @ApiProperty({
    description: '브랜드 코드',
  })
  code: string;

  @ApiProperty({
    description: '브랜드 한글 이름',
  })
  nameKorean: string;

  @ApiProperty({
    description: '브랜드 영문 이름',
  })
  nameEnglish: string;

  @ApiProperty({
    description: '브랜드 사용 유무',
  })
  isUsed: boolean;
}
