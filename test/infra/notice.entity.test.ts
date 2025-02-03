import { NoticeEntity } from '../../src/entity/notice.entity';
import { UserEntityTest } from './user.entity.test';
import { NoticePriority } from '../../src/notice/interface/notice.priority';

export const NoticeEntityTest = (): NoticeEntity => {
  return {
    content: '',
    createdAt: new Date(),
    deletedAt: null,
    filePath: null,
    id: 0,
    priority: NoticePriority.LOW,
    registerAt: new Date(),
    title: '',
    updatedAt: new Date(),
    user: { ...UserEntityTest() },
    userId: 0,
  };
};
