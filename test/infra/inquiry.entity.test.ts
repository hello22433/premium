import { InquiryEntity } from '../../src/entity/inquiry.entity';
import { UserEntityTest } from './user.entity.test';
import { InquiryStatus } from '../../src/inquiry/interface/inquiry.status';

export const InquiryEntityTest = (): InquiryEntity => {
  return {
    content: '',
    createdAt: new Date(),
    deletedAt: null,
    filePath: null,
    id: 0,
    replyContent: null,
    status: InquiryStatus.PROGRESS,
    title: '',
    updatedAt: new Date(),
    user: UserEntityTest(),
    userId: 0,
  };
};
