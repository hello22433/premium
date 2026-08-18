import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PinIssueCommandEntity } from '../entity/pin.issue.command.entity';
import { SsgPinObservationCandidateEntity } from '../entity/ssg.pin.observation.candidate.entity';
import { SsgPinObservationRunEntity } from '../entity/ssg.pin.observation.run.entity';
import { SsgAutoResolveConfig } from './application/ssg.autoresolve.config';
import { SsgPinObservationService } from './application/ssg.pin.observation.service';

/**
 * EP-P30 롤아웃 스위치 + 관측 writer. 판정 소비자(배치·sweep·발급)가 전부 같은 capability 판정을
 * 공유해야 하므로 별도 모듈로 분리한다.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([SsgPinObservationRunEntity, SsgPinObservationCandidateEntity, PinIssueCommandEntity]),
  ],
  providers: [SsgAutoResolveConfig, SsgPinObservationService],
  exports: [SsgAutoResolveConfig, SsgPinObservationService],
})
export class SsgAutoResolveModule {}
