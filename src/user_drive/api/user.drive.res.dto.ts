import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ApiProperty } from '@nestjs/swagger';
import { UserDriveViewDto } from './dto/user.drive.view.dto';
import { UserDriveDetailDto } from './dto/user.drive.detail.dto';

export class UserDriveGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '문서함 리스트',
  })
  list: UserDriveViewDto[];
}

export class UserDriveGetDetailResDto extends UserDriveDetailDto {}
