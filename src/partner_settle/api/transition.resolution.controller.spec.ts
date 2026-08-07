import { PATH_METADATA } from '@nestjs/common/constants';
import { TransitionResolutionController } from './transition.resolution.controller';

describe('TransitionResolutionController routes', () => {
  it('uses canonical transition resolution routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, TransitionResolutionController.prototype.propose)).toBe(
      ':observationId/propose',
    );
    expect(Reflect.getMetadata(PATH_METADATA, TransitionResolutionController.prototype.approve)).toBe(
      ':proposalId/approve',
    );
    expect(Reflect.getMetadata(PATH_METADATA, TransitionResolutionController.prototype.reject)).toBe(
      ':proposalId/reject',
    );
  });
});
