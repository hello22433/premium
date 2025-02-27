import { ApiProperty } from '@nestjs/swagger';

export class UserBizGetBuzInfoDto {
  @ApiProperty({
    description: '회사 이름',
  })
  businessName: string;

  @ApiProperty({
    description: '회사 주소',
  })
  businessAddress: string;

  @ApiProperty({
    description: '사업자 등록 번호',
  })
  businessNumber: string;

  @ApiProperty({
    description: '회사 전화번호',
  })
  businessPhoneNumber: string;
}

export class UserBizGetBuzInfoResDto {
  @ApiProperty({
    description: 'OK : 성공, ERROR :오류',
  })
  statusCode: string;

  @ApiProperty({
    type: UserBizGetBuzInfoDto,
    nullable: true,
    description: '',
  })
  data: UserBizGetBuzInfoDto | null;
}
