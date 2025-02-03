import { InquiryViewDto } from './dto/inquiry.view.dto';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ApiProperty } from '@nestjs/swagger';
import { InquiryDetailDto } from './dto/inquiry.detail.dto';

export class InquiryGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '1:1문의 리스트',
  })
  list: InquiryViewDto[];
}

export class InquiryGetDetailResDto extends InquiryDetailDto {}
