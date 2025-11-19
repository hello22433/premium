import { UserAuthMainEnum, UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { ApiProperty } from '@nestjs/swagger';

export class UserGetAuthListResDto {
  @ApiProperty({
    description: '메인 메뉴 리스트',
  })
  mainMenuList: UserAuthMainEnum[];

  @ApiProperty({
    description: '서브 메뉴 리스트',
  })
  subMenuList: UserAuthSubEnum[];
}
