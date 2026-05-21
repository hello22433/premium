import { IsArray, IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class AllocationPreviewReqDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  orderId: number;

  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  deliveryIds: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  pointUseAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  depositUseAmount?: number;
}
