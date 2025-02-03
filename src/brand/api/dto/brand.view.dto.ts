import { ApiProperty } from '@nestjs/swagger';

export class BrandViewDto {
  @ApiProperty({
    description: 'brand id',
  })
  id: number;

  @ApiProperty({
    description: '브랜드 코드',
  })
  code: string;

  @ApiProperty({
    description: '브랜드명 (한글)',
  })
  nameKorean: string;

  @ApiProperty({
    description: '브랜드명 (영문)',
  })
  nameEnglish: string;

  @ApiProperty({
    description: '브랜드명 사용여부 ex) true: 사용',
  })
  isUsed: boolean;
}
