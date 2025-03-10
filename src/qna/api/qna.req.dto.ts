import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class QnaGetListReqDto extends PagingReqDto {}
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
