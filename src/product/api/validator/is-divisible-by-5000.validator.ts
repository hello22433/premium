import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

// 5,000원 단위 검사 Validator
@ValidatorConstraint({ async: false })
export class IsDivisibleBy5000Constraint implements ValidatorConstraintInterface {
  validate(value: number, args: ValidationArguments) {
    return value % 5000 === 0; // 5,000원 단위인지 확인
  }

  defaultMessage(args: ValidationArguments) {
    return '금액은 5,000원 단위로 입력해야 합니다.';
  }
}

// 데코레이터 함수
export function IsDivisibleBy5000(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsDivisibleBy5000Constraint,
    });
  };
}
