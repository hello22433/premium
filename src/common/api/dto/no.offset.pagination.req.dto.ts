import { IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class NoOffsetPagingReqDto {
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: '마지막 id',
  })
  // ====================
  @IsOptional()
  @Min(1)
  @Type(() => Number)
  lastId?: number;

  @ApiPropertyOptional({
    type: Number,
    default: 10,
    description: '가져오고자 하는 데이터 개수',
  })
  // ====================
  @IsOptional()
  @Min(1)
  @Max(1000)
  @Type(() => Number)
  take: number = 10;
}
