import { ISsgIssue } from '../interface/ssg.issue';
import { Injectable } from '@nestjs/common';

@Injectable()
export class SsgIssue implements ISsgIssue {
  constructor() {}

  async issue(prefix: string, length: number): Promise<string> {
    // 난수를 length 자릿수로 제한
    const max = Math.pow(10, length); // 최대 값 (10^length)
    const randomNumber = Math.floor(Math.random() * max); // 0부터 max-1 사이의 랜덤 숫자 생성

    // 자릿수 보장 (부족한 경우 앞에 '0' 추가)
    const paddedNumber = randomNumber.toString().padStart(length, '0');

    // 접두사와 결합한 결과 반환
    return prefix + paddedNumber;
  }
}
