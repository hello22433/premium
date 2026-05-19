export const mockRepositoryMethod = {};

export const createMockRepositoryMethod = () => ({
  create: jest.fn(),
  save: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
  softDelete: jest.fn(),
  count: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  findOneBy: jest.fn(),
  query: jest.fn(),
});
