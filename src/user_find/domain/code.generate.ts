export const generateRandomCode = (length: number = 8): string => {
  if (length <= 0) {
    throw new Error('Length must be greater than 0.');
  }

  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';

  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return code;
};

export const generateNumericCode = (length: number = 5): string => {
  if (length <= 0) {
    throw new Error('Length must be greater than 0.');
  }

  let code = '';
  for (let i = 0; i < length; i++) {
    code += Math.floor(Math.random() * 10).toString();
  }

  return code;
};
