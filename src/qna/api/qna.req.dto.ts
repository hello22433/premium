import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { IQnaMainCategory, IQnaSubCategory } from '../interface/qna.category';

export class QnaGetListReqDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '문의 유형 필터',
    enum: IQnaMainCategory,
  })
  // =================================
  @IsOptional()
  @IsEnum(IQnaMainCategory)
  mainCategory?: IQnaMainCategory;
}
export class QnaGetDetailReqParamDto {
  @ApiProperty({
    description: 'qna id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}
export class QnaAnswerReqDto extends QnaGetDetailReqParamDto {
  @ApiProperty({
    description: '답변 내용',
  })
  // =================================
  @IsNotEmpty()
  @IsString()
  answer: string;
}

export class QnaUpdateAnswerReqDto extends QnaAnswerReqDto {}

export class QnaCreateReqDto {
  @ApiProperty({
    description: '문의 유형',
    enum: IQnaMainCategory,
  })
  // =================================
  @IsNotEmpty()
  @IsEnum(IQnaMainCategory)
  mainCategory: IQnaMainCategory;

  @ApiPropertyOptional({
    description: '상세항목 (CS접수 시 필수)',
    enum: IQnaSubCategory,
  })
  // =================================
  @IsOptional()
  @IsEnum(IQnaSubCategory)
  subCategory?: IQnaSubCategory;

  @ApiProperty({
    description: '제목',
  })
  // =================================
  @IsNotEmpty()
  title: string;

  @ApiProperty({
    description: '문의 내용',
  })
  // =================================
  @IsNotEmpty()
  content: string;

  @ApiPropertyOptional({
    description: '첨부파일 이미지 url list',
  })
  // =================================
  @IsOptional()
  @IsArray()
  filePathList: string[];
}
