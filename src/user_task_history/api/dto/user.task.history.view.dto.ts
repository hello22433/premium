import { ApiProperty } from '@nestjs/swagger';

export class UserTaskHistoryViewDto {
  @ApiProperty({
    description: 'user id',
  })
  id: number;

  @ApiProperty({
    description: '등록일 ex) yyyy-MM-dd',
  })
  registerDate: string;

  @ApiProperty({
    description: '이메일',
  })
  email: string;

  @ApiProperty({
    description: '담당자 코드',
  })
  personCode: string;

  @ApiProperty({
    description: '고객사명',
  })
  businessName: string;

  @ApiProperty({
    description: '담당자 이름',
  })
  personName: string;

  @ApiProperty({
    description: '거래금액',
  })
  transactionAmount: number;

  @ApiProperty({
    description: '거래횟수',
  })
  transactionCount: number;

  @ApiProperty({
    description: '고객사 등급',
  })
  businessGrade: string;

  @ApiProperty({
    description: '담당자 분류',
  })
  personCategory: string;

  @ApiProperty({
    description: '최초거래일 ex) yyyy-MM-dd',
  })
  firstTransactionDate: string | null;

  @ApiProperty({
    description: '최종거래일 ex) yyyy-MM-dd',
  })
  lastTransactionDate: string | null;
}
