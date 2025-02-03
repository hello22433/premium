import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

export class InquiryGetListReqQueryDto extends PagingReqDto {}

export class InquiryGetDetailReqParamDto {
  @ApiProperty({
    description: '문의 id',
  })
  // ==================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class InquiryCreateReqDto {
  @ApiProperty({
    description: '첨부파일 리스트',
  })
  // =========================
  @IsArray()
  filePathList: string[];

  @ApiProperty({
    description: '1:1 문의 제목',
  })
  // =========================
  @IsNotEmpty()
  title: string;

  @ApiProperty({
    description: '1:1 문의 내용',
  })
  // =========================
  @IsNotEmpty()
  content: string;
}

export class InquiryReplyReqDto {
  @ApiProperty({
    description: '답변하고자 하는 1:1 문의 id',
  })
  // ========================================
  @IsNotEmpty()
  @IsNumber()
  id: number;

  @ApiProperty({
    description: '답글 내용',
  })
  // ========================================
  @IsNotEmpty()
  replyContent: string;
}
