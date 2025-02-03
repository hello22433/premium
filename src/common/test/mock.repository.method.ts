export const mockRepositoryMethod = {
  create: jest.fn(),
  save: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
  softDelete: jest.fn(),
  count: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  query: jest.fn(),
};

export const createMockRepositoryMethod = () => ({
  ...mockRepositoryMethod,
});
