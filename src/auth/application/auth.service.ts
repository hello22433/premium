import { ForbiddenException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { UserEntity } from '../../entity/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { ILoginUserInfo } from '../interface/login.user';
import { Repository } from 'typeorm';
import { UserAuthListDefault } from '../../user_info/domain/user.auth.list.default';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) {}

  async authorityValidator(user: ILoginUserInfo, subMenu: UserAuthSubEnum) {
    const oneUser = await this.userRepository.findOne({
      where: {
        id: user.id,
      },
    });

    if (!oneUser) {
      throw new InternalServerErrorException('유저가 존재하지 않습니다.');
    }

    const authorityList = UserAuthListDefault(oneUser.authority, oneUser.authorityList);

    if (!authorityList.includes(subMenu)) {
      throw new ForbiddenException('권한이 없습니다.');
    }
  }
}
