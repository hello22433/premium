import { ApiProperty } from '@nestjs/swagger';
import { UserSyncProductEventViewDto } from './dto/user.sync.product.event.view.dto';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { UserSyncProductEventDetailDto } from './dto/user.sync.product.event.detail.dto';
import { UserSyncProductPersonInfoDto } from './dto/user.sync.product.person.info.dto';
import { UserSyncProductPersonProductViewDto } from './dto/user.sync.product.person.product.view.dto';

export class UserSyncProductGetListResDto extends GetListResDto {
  @ApiProperty({
    description: '연동 상품 이벤트 list',
  })
  list: UserSyncProductEventViewDto[];
}

export class UserSyncProductGetDetailResDto {
  @ApiProperty({
    description: '고객사 user.id',
  })
  userId: number;

  @ApiProperty({
    description: '기본 고객사 여부',
  })
  isHeadPerson: boolean;

  @ApiProperty({
    description: '고객사 명',
  })
  businessUserName: string;

  @ApiProperty({
    description: '고객사 대표 담당자',
  })
  businessPersonName: string;

  @ApiProperty({
    description: '연동 상품 list',
  })
  list: UserSyncProductEventDetailDto[];
}

export class UserSyncProductGetPersonsByBusinessResDto {
  @ApiProperty({
    description: '사업자 번호',
  })
  businessNumber: string;

  @ApiProperty({
    description: '사업자명',
  })
  businessName: string;

  @ApiProperty({
    description: '담당자 수',
  })
  personCount: number;

  @ApiProperty({
    description: '담당자 목록',
  })
  persons: UserSyncProductPersonInfoDto[];
}

export class UserSyncProductGetHeadPersonListResDto extends GetListResDto {
  @ApiProperty({
    description: '고객사 기본 담당자 정보 list',
  })
  list: UserSyncProductPersonProductViewDto[];
}
