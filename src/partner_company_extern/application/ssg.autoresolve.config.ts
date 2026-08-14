import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinIssueCommandEntity } from '../../entity/pin.issue.command.entity';
import {
  SsgAutoResolveCapability,
  SsgAutoResolveMode,
  isDrainableCommand,
  parseSsgAutoResolveMode,
  resolveSsgAutoResolveCapability,
} from '../domain/ssg.autoresolve.policy';

/**
 * EP-P30 롤아웃 스위치 (`SSG_PIN_AUTORESOLVE_MODE`).
 *
 * 미설정·오타는 `off` 다(fail-closed). 코드는 모드가 아니라 **capability** 를 검사한다 —
 * 단일 `on` 값이 단계마다 다른 권한을 갖고, `off` 도 신규/drain 두 문맥으로 갈리기 때문이다(§9-3).
 */
@Injectable()
export class SsgAutoResolveConfig implements OnModuleInit {
  private readonly logger = new Logger('SSG_AUTORESOLVE');

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.logger.log(
      `[P30] SSG_PIN_AUTORESOLVE_MODE=${this.mode} (raw='${this.configService.get<string>('SSG_PIN_AUTORESOLVE_MODE') ?? ''}')`,
    );
  }

  get mode(): SsgAutoResolveMode {
    return parseSsgAutoResolveMode(this.configService.get<string>('SSG_PIN_AUTORESOLVE_MODE'));
  }

  /** command 문맥의 capability. command 를 모르는 경로(신규 유입)는 drain 대상이 아니다. */
  capabilityFor(command?: Pick<PinIssueCommandEntity, 'autoresolveVersion'> | null): SsgAutoResolveCapability {
    return resolveSsgAutoResolveCapability(this.mode, isDrainableCommand(command));
  }
}
