import { Module } from '@nestjs/common';
import { PasswordBcryptEncrypt } from './infrastructure/password.bcrypt.encrypt';
import { LoginTokenValidatorJsonwebtoken } from './infrastructure/login.token.validator.jsonwebtoken';
import { CryptoCipher } from '../common/infra/crypto.cipher';
import { AuthService } from './application/auth.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '../entity/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity])],
  controllers: [],
  providers: [
    PasswordBcryptEncrypt,
    {
      provide: 'ILoginTokenValidator',
      useClass: LoginTokenValidatorJsonwebtoken,
    },
    CryptoCipher,
    AuthService,
  ],
  exports: [
    PasswordBcryptEncrypt,
    {
      provide: 'ILoginTokenValidator',
      useClass: LoginTokenValidatorJsonwebtoken,
    },
    CryptoCipher,
    AuthService,
  ],
})
export class AuthModule {}
