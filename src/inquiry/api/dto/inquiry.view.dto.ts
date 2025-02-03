import { ApiProperty } from '@nestjs/swagger';

export class InquiryViewDto {
  @ApiProperty({
    description: '1:1 문의 번호',
  })
  id: number;

  @ApiProperty({
    description: '1:1 등록 일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  createdAt: string;

  @ApiProperty({
    description: '고객사 명',
  })
  userBusinessName: string;

  @ApiProperty({
    description: '담당자 명',
  })
  userPersonName: string;

  @ApiProperty({
    description: '제목',
  })
  title: string;

  @ApiProperty({
    description: '첨부파일 여부',
  })
  isFilePath: boolean;

  @ApiProperty({
    description: '답변 여부',
  })
  isAnswer: boolean;
}
