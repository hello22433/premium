import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '../../entity/user.entity';
import { LoginTokenValidatorJsonwebtoken } from '../../auth/infrastructure/login.token.validator.jsonwebtoken';
import { IUserAuthority } from '../../user/interface/user.authority';

/**
 * settlement_code scope guard.
 * - SUPER_ADMIN / OPERATION_ADMIN: 모든 scope 허용.
 * - CORPORATE_ADMIN: 본인 user.settlement_code 와 일치하는 target 만 허용.
 * - target settlement_code 는 query/body 의 `settlementCode` 필드에서 추출.
 *
 * PR1b 는 정의만. PR3 에서 controller 에 부착 (운영자 UI 작업 시점).
 */
@Injectable()
export class SettlementCodeScopeGuard implements CanActivate {
  constructor(
    @Inject('ILoginTokenValidator')
    private readonly loginTokenValidator: LoginTokenValidatorJsonwebtoken,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const bearer = req.get('Authorization');
    if (!bearer) throw new ForbiddenException('토큰이 없습니다.');
    req.user = this.loginTokenValidator.validateByToken(bearer.split(' ')[1]);

    if (req.user.authority === IUserAuthority.SUPER_ADMIN || req.user.authority === IUserAuthority.OPERATION_ADMIN) {
      return true;
    }

    const target = (req.body?.settlementCode ?? req.query?.settlementCode ?? req.params?.settlementCode) as
      | string
      | undefined;
    if (!target) throw new ForbiddenException('settlementCode required');

    const me = await this.userRepository.findOne({ where: { id: req.user.id }, select: ['id', 'settlementCode'] });
    if (!me || me.settlementCode !== target) {
      throw new ForbiddenException('settlement_code scope mismatch');
    }
    return true;
  }
}
