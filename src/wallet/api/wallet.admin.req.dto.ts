import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class IssueGrantReqDto {
  @IsString()
  @MaxLength(50)
  settlementCode: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  expiresAt?: string; // ISO 8601

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @IsString()
  @MaxLength(120)
  idempotencyKey: string;
}

export class ApproveCreditExcessReqDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  comment?: string;
}

export class RejectCreditExcessReqDto {
  @IsString()
  @MaxLength(200)
  rejectReason: string;
}
