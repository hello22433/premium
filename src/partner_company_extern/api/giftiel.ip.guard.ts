import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:/, '');
}

@Injectable()
export class GiftielIpGuard implements CanActivate {
  private readonly logger = new Logger('GIFTIEL_PUSH');
  private readonly allowedIps: string[];

  constructor(private configService: ConfigService) {
    const envIps = this.configService.get<string>('GIFTIEL_PUSH_ALLOWED_IPS');
    this.allowedIps = envIps
      ? envIps
          .split(',')
          .map((ip) => ip.trim())
          .filter(Boolean)
      : [];
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const clientIp = normalizeIp(request.ip || '');

    if (this.allowedIps.length === 0) {
      this.logger.error('GIFTIEL_PUSH_ALLOWED_IPS 환경변수가 설정되지 않음 - 모든 요청 차단');
      throw new ForbiddenException('Access denied');
    }

    if (!this.allowedIps.includes(clientIp)) {
      this.logger.warn(`차단된 IP: ${clientIp}`);
      throw new ForbiddenException(`Access denied: ${clientIp}`);
    }

    (request as any).giftielClientIp = clientIp;
    return true;
  }
}
