import { ApiProperty } from '@nestjs/swagger';
import { IQnaMainCategory } from '../../interface/qna.category';

export class QnaViewDto {
  @ApiProperty({
    description: 'qna id',
  })
  id: number;

  @ApiProperty({
    description: '등록일 ex) yyyy-MM-dd',
  })
  registerDate: string;

  @ApiProperty({
    description: 'qna 등록한 고객사(사업자) 명',
  })
  businessName: string;

  @ApiProperty({
    description: 'qna 등록한 담당자 명',
  })
  personName: string;

  @ApiProperty({
    description: '제목',
  })
  title: string;

  @ApiProperty({
    description: '첨부파일 유무',
  })
  isFile: boolean;

  @ApiProperty({
    description: '답변 유무',
  })
  isAnswer: boolean;

  @ApiProperty({
    description: '문의 유형',
    enum: IQnaMainCategory,
  })
  mainCategory: IQnaMainCategory;

  @ApiProperty({
    description: '문의 유형 한글',
  })
  mainCategoryKo: string;
}
