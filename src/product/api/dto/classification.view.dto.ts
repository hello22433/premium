import { ApiProperty } from '@nestjs/swagger';

export class ClassificationViewDto {
  @ApiProperty({
    description: 'classification id',
  })
  id: number;

  @ApiProperty({
    description: '대분류명',
  })
  classification: string;
}
