import { ApiProperty } from '@nestjs/swagger';

export class OrderReceiveChoiceDto {
  @ApiProperty({
    description: 'product id',
  })
  id: number;

  @ApiProperty({
    description: 'product 이름',
  })
  name: string;

  @ApiProperty({
    description: 'product 이미지',
  })
  imagePath: string;

  @ApiProperty({
    description: 'product 가격',
  })
  price: number;

  @ApiProperty({
    description: 'product 유효 일',
  })
  expireDay: number;

  @ApiProperty({
    description: '브랜드 한글 명',
  })
  brandNameKorean: string;

  @ApiProperty({
    description: '브랜드 영문 명',
  })
  brandNameEnglish: string;
}
