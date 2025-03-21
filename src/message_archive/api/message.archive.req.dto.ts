import { IsNotEmpty, IsNumber, IsString } from 'class-validator';
import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { ApiProperty } from '@nestjs/swagger';

export class MessageArchiveGetListReqQueryDto extends PagingReqDto {}

export class MessageArchiveCreateReqDto {
  @ApiProperty({
    description: '제목',
  })
  // =======================
  @IsString()
  title: string;

  @ApiProperty({
    description: '내용',
  })
  // =======================
  @IsString()
  content: string;
}

export class MessageArchiveDeleteReqDto {
  @ApiProperty({
    description: '삭제할 문서함 id',
  })
  // =======================
  @IsNotEmpty()
  @IsNumber()
  id: number;
}
