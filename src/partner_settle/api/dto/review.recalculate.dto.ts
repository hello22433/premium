import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  MaxLength,
  Min,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidateIf,
} from 'class-validator';

function IsRecalculateTarget(validationOptions?: ValidationOptions): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      name: 'isRecalculateTarget',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(_: unknown, args: ValidationArguments): boolean {
          const value = args.object as ReviewRecalculateReqDto;
          const hasLedgerIds = value.ledgerIds !== undefined;
          const hasPartnerCompanyId = value.partnerCompanyId !== undefined;
          return hasLedgerIds !== hasPartnerCompanyId && (!hasLedgerIds || value.subItemKey === undefined);
        },
        defaultMessage(): string {
          return 'ledgerIds 또는 partnerCompanyId와 subItemKey 조합 중 하나만 지정해야 합니다.';
        },
      },
    });
  };
}

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

export class ReviewRecalculateReqDto {
  @IsRecalculateTarget()
  private readonly target?: never;

  @ApiPropertyOptional({ type: [Number], description: '재계산할 원장 ID 목록' })
  @ValidateIf((object: ReviewRecalculateReqDto) => object.ledgerIds !== undefined)
  @IsArray()
  @ArrayNotEmpty()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ledgerIds?: number[];

  @ApiPropertyOptional({ minimum: 1, description: '재계산 대상 협력사 ID' })
  @ValidateIf((object: ReviewRecalculateReqDto) => object.ledgerIds === undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  partnerCompanyId?: number;

  @ApiPropertyOptional({ maxLength: 255, description: '협력사 대상의 선택적 하위 상품 키' })
  @ValidateIf((object: ReviewRecalculateReqDto) => object.subItemKey !== undefined)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  subItemKey?: string;
}
