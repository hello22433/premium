import { IsString } from 'class-validator';
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
