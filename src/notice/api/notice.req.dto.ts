import { Type } from 'class-transformer';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { NoticePriority } from '../interface/notice.priority';
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsIn, IsNotEmpty, IsNumber } from 'class-validator';

export class NoticeGetListReqQueryDto extends PagingReqDto {}

export class NoticeGetDetailReqParamDto {
  @ApiProperty({
    description: 'notice id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class NoticeCreateReqDto {
  @ApiProperty({
    description: '공지사항 제목',
  })
  // =================================
  @IsNotEmpty()
  title: string;

  @ApiProperty({
    description: '공지사항 내용',
  })
  // =================================
  @IsNotEmpty()
  content: string;

  @ApiProperty({
    description: '공지사항 내용',
  })
  // =================================
  @IsIn(['HIGH', 'MEDIUM', 'LOW'])
  @IsNotEmpty()
  priority: NoticePriority;

  @ApiProperty({
    description: '공지사항 첨부파일 list ',
  })
  // =================================
  @IsArray()
  filePath: string[];
}

export class NoticeUpdateReqDto extends NoticeCreateReqDto {
  @ApiProperty({
    description: 'notice id ',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  id: number;
}
