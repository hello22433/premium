export const mockQueryBuilder = {};

export const createMockQueryBuilder = () => ({
  where: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  addSelect: jest.fn().mockReturnThis(),
  getRawMany: jest.fn().mockResolvedValue([]),
  getRawOne: jest.fn().mockResolvedValue(undefined),
  getCount: jest.fn().mockResolvedValue(0),
  andWhere: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  take: jest.fn().mockReturnThis(),
  innerJoinAndSelect: jest.fn().mockReturnThis(),
  leftJoinAndSelect: jest.fn().mockReturnThis(),
  getMany: jest.fn().mockResolvedValue([]),
  getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
});
