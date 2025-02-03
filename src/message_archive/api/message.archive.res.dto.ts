import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { MessageArchiveViewDto } from './dto/message.archive.view.dto';
import { ApiProperty } from '@nestjs/swagger';

export class MessageArchiveGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '문자 보관함 list',
  })
  list: MessageArchiveViewDto[];
}
