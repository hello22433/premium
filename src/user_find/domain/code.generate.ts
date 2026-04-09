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

// 로그인 인증코드 전용: 사람 눈에 혼동되기 쉬운 문자(0/O, 1/I/l) 및
// 대소문자 구분을 제거하여 사용자 입력 실수를 줄인다.
export const generateLoginVerifyCode = (length: number = 8): string => {
  if (length <= 0) {
    throw new Error('Length must be greater than 0.');
  }

  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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
