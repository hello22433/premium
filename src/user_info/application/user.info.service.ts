import { UserEntity } from '../../entity/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { UserInfoChangePasswordReqDto } from '../api/user.info.req.dto';
import { PasswordBcryptEncrypt } from '../../auth/infrastructure/password.bcrypt.encrypt';
import { UserAuthListDefault } from '../domain/user.auth.list.default';
import { UserAuthMainMenuAuthList } from '../domain/user.auth.main.menu.auth.list';
import { UserGetAuthListResDto } from '../api/user.info.res.dto';
import { IOrderSendMethod } from '../../order/interface/order.send.method';

@Injectable()
export class UserInfoService {
  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private readonly passwordEncrypt: PasswordBcryptEncrypt,
  ) {}

  async changePassword(user: ILoginUserInfo, getBody: UserInfoChangePasswordReqDto) {
    const oneUser = await this.userRepository.findOne({
      where: {
        id: user.id,
      },
    });

    if (!oneUser) {
      throw new BadRequestException('유저가 존재하지 않습니다.');
    }

    oneUser.password = await this.passwordEncrypt.encrypt(getBody.password);
    oneUser.isPasswordReset = false;
    oneUser.passwordChangedAt = new Date();
    await this.userRepository.save(oneUser);
    return;
  }

  async postponePasswordChange(user: ILoginUserInfo) {
    const oneUser = await this.userRepository.findOne({
      where: {
        id: user.id,
      },
    });

    if (!oneUser) {
      throw new BadRequestException('유저가 존재하지 않습니다.');
    }

    // passwordChangedAt이 null이면 연기 불가 (임시 비밀번호는 반드시 변경해야 함)
    if (!oneUser.passwordChangedAt) {
      throw new BadRequestException('임시 비밀번호는 반드시 변경해야 합니다.');
    }

    // passwordChangedAt을 현재 날짜로 업데이트하여 비밀번호 변경 연기
    oneUser.passwordChangedAt = new Date();
    await this.userRepository.save(oneUser);
    return;
  }

  async getAuthList(user: ILoginUserInfo): Promise<UserGetAuthListResDto> {
    const oneUser = await this.userRepository.findOne({
      where: {
        id: user.id,
      },
    });

    if (!oneUser) {
      throw new BadRequestException('유저가 존재하지 않습니다.');
    }

    const authList = UserAuthListDefault(oneUser.authority, oneUser.authorityList);

    const mainMenuList = UserAuthMainMenuAuthList(authList);

    const allowedSendMethods = oneUser.allowedSendMethods
      ? (oneUser.allowedSendMethods.split(',') as IOrderSendMethod[])
      : [IOrderSendMethod.ALIM_TALK, IOrderSendMethod.SMS, IOrderSendMethod.EMAIL];

    return {
      mainMenuList,
      subMenuList: authList,
      allowedSendMethods,
    };
  }
}
