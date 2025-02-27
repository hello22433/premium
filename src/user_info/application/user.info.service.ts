import { UserEntity } from '../../entity/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { UserInfoChangePasswordReqDto } from '../api/user.info.req.dto';
import { PasswordBcryptEncrypt } from '../../auth/infrastructure/password.bcrypt.encrypt';

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
    await this.userRepository.save(oneUser);
    return;
  }
}
