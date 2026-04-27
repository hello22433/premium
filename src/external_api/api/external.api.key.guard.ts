import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';

import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';
import { ExternalApiException } from './external.api.exception.filter';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @InjectRepository(ExternalApiAccountEntity)
    private accountRepository: Repository<ExternalApiAccountEntity>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-api-key'] as string;
    if (!apiKey) {
      throw new ExternalApiException('1001', '인증 실패');
    }

    const keyHash = createHash('sha256').update(apiKey).digest('hex');
    const account = await this.accountRepository.findOne({
      where: { apiKeyHash: keyHash, isActive: true },
      relations: ['user', 'user.company', 'allowedIps'],
    });

    if (!account) {
      throw new ExternalApiException('1001', '인증 실패');
    }

    const callerIp = this.resolveCallerIp(request);
    const allowed = (account.allowedIps ?? []).some((ip) => ip.ipAddress === callerIp);
    if (!allowed) {
      throw new ExternalApiException('1004', '허용되지 않은 IP', callerIp);
    }

    request.apiAccount = account;
    return true;
  }

  private resolveCallerIp(request: any): string {
    const forwarded = request.headers['x-forwarded-for'] as string | undefined;
    const raw = forwarded
      ? forwarded.split(',')[0].trim()
      : request.ip || request.connection?.remoteAddress || '';
    return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  }
}
