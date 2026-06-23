import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** 3계층 매핑모드(PR2) 고객 매핑 등록 요청. */
export class CreateCustomerMappingReqDto {
  @ApiProperty({ description: '외부 고객 식별자 (api_app 내 유니크)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(191)
  externalCustomerId: string;

  @ApiProperty({ description: '매핑 차감대상 billing user id' })
  @IsInt()
  billingUserId: number;
}

/** 고객 매핑 수정(billing user 변경) 요청. */
export class UpdateCustomerMappingReqDto {
  @ApiProperty({ description: '매핑 차감대상 billing user id' })
  @IsInt()
  billingUserId: number;
}

/** 고객 매핑 응답(메타). */
export class CustomerMappingResDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  apiAppId: string;

  @ApiProperty()
  externalCustomerId: string;

  @ApiProperty()
  billingUserId: number;
}
