import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

const DEFAULT_ALLOWED_IPS = [
  '127.0.0.1',
  '121.156.124.210',
  '121.156.122.223',
  '222.122.28.80',
  '121.156.122.179',
];

const IP_GIFT_KIND_MAP: Record<string, 'cpn' | 'dept'> = {
  '121.156.122.223': 'cpn',
  '121.156.122.179': 'dept',
};

function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:/, '');
}

@Injectable()
export class GalaxiaIpGuard implements CanActivate {
  private readonly logger = new Logger('GALAXIA_PUSH');
  private readonly allowedIps: string[];

  constructor(private configService: ConfigService) {
    const envIps = this.configService.get<string>('GALAXIA_PUSH_ALLOWED_IPS');
    this.allowedIps = envIps
      ? envIps.split(',').map((ip) => ip.trim())
      : DEFAULT_ALLOWED_IPS;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const clientIp = normalizeIp(request.ip || '');

    if (!this.allowedIps.includes(clientIp)) {
      this.logger.warn(`차단된 IP: ${clientIp}`);
      throw new ForbiddenException(`Access denied: ${clientIp}`);
    }

    (request as any).galaxiaClientIp = clientIp;
    return true;
  }

  static getGiftKindByIp(ip: string): 'cpn' | 'dept' | null {
    return IP_GIFT_KIND_MAP[normalizeIp(ip)] ?? null;
  }
}
