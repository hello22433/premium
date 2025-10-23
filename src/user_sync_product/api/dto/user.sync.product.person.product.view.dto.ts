import { ApiProperty } from '@nestjs/swagger';

export class UserSyncProductPersonProductViewDto {
  @ApiProperty({
    description: '기본 담당자 이메일',
  })
  headPersonEmail: string;

  @ApiProperty({
    description: '기본계정 user.id',
  })
  headPersonUserId: number;

  @ApiProperty({
    description: '고객사명',
  })
  businessName: string;

  @ApiProperty({
    description: '기본 담당자 이름',
  })
  headPersonName: string;

  @ApiProperty({
    description: '브랜드수 (연동 상품에 포함된 고유 브랜드 수)',
  })
  brandCount: number;

  @ApiProperty({
    description: '등록상품수 (연동 이벤트에 등록된 총 상품 수)',
  })
  productCount: number;
}
