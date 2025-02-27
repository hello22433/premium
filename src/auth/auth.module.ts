import { Module } from '@nestjs/common';
import { PasswordBcryptEncrypt } from './infrastructure/password.bcrypt.encrypt';
import { LoginTokenValidatorJsonwebtoken } from './infrastructure/login.token.validator.jsonwebtoken';
import { CryptoCipher } from '../common/infra/crypto.cipher';

@Module({
  imports: [],
  controllers: [],
  providers: [
    PasswordBcryptEncrypt,
    {
      provide: 'ILoginTokenValidator',
      useClass: LoginTokenValidatorJsonwebtoken,
    },
    CryptoCipher,
  ],
  exports: [
    PasswordBcryptEncrypt,
    {
      provide: 'ILoginTokenValidator',
      useClass: LoginTokenValidatorJsonwebtoken,
    },
    CryptoCipher,
  ],
})
export class AuthModule {}
