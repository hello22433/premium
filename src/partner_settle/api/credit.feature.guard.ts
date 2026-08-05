import { NotFoundException } from '@nestjs/common';
import { CreditFeatureFlag } from '../application/credit.feature.flag';

/**
 * 여신 API flag off 시 엔드포인트를 미노출(404)한다 (정본 §15.2).
 *
 * flag on 은 마이그레이션·config seed·`SETTLE_CREDIT` 권한 배포 완료 후의 배포 단계 소관이다.
 */
export function assertCreditApiEnabled(flag: CreditFeatureFlag): void {
  if (!flag.creditApiEnabled) {
    throw new NotFoundException('여신관리 API 가 아직 활성화되지 않았습니다.');
  }
}
