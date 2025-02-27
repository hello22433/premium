export const passwordRegex = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,12}$/;

export const generateRandomPassword = (): string => {
  const length = Math.floor(Math.random() * (12 - 8 + 1)) + 8;

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const specialChars = '@$!%*?&';
  const allChars = letters + numbers + specialChars;

  let password = '';

  // 최소 조건을 만족하도록 하나씩 추가
  password += letters.charAt(Math.floor(Math.random() * letters.length));
  password += numbers.charAt(Math.floor(Math.random() * numbers.length));
  password += specialChars.charAt(Math.floor(Math.random() * specialChars.length));

  // 나머지 길이만큼 임의로 채우기
  for (let i = 3; i < length; i++) {
    password += allChars.charAt(Math.floor(Math.random() * allChars.length));
  }

  // 랜덤하게 섞기
  password = password
    .split('')
    .sort(() => 0.5 - Math.random())
    .join('');

  return password;
};
