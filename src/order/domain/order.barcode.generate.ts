export const orderBarcodeGenerate = () => {
  // Math.random()을 사용하여 11자리 숫자를 생성
  let randomNumber = Math.floor(Math.random() * 10 ** 11).toString();

  // 11자리가 되도록 앞에 0을 추가
  while (randomNumber.length < 11) {
    randomNumber = "0" + randomNumber;
  }

  return randomNumber;
}
