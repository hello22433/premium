import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';
import { UserEntity } from '../../entity/user.entity';
import { IUserStatus } from '../../user/interface/user.status';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-api-key'] as string;
    if (!apiKey) {
      throw new UnauthorizedException();
    }

    const keyHash = createHash('sha256').update(apiKey).digest('hex');
    const user = await this.userRepository.findOne({
      where: { apiKeyHash: keyHash, status: IUserStatus.USED },
      select: {
        id: true, email: true, authority: true, companyId: true, balance: true,
        company: { id: true, balanceManagementType: true, balance: true },
      },
      relations: ['company'],
    });

    if (!user) {
      throw new UnauthorizedException();
    }

    request.user = { id: user.id, email: user.email, authority: user.authority };
    request.apiUser = user;
    return true;
  }
}
