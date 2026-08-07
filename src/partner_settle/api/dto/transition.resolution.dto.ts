import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const normalizeText = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.normalize('NFC').trim() : value;

export class TransitionForwardFactsDto {
  @ApiProperty({ enum: ['FORWARD'] }) @IsIn(['FORWARD']) action: 'FORWARD';
  @ApiProperty() @IsString() @Matches(/^[1-9]\d*$/) baseAmount: string;
  @ApiProperty() @Transform(normalizeText) @IsString() @IsNotEmpty() @MaxLength(255) subItemKey: string;
}
export class TransitionReversalAllocationDto {
  @ApiProperty() @IsInt() @Min(1) reversesLedgerId: number;
  @ApiProperty() @IsString() @Matches(/^[1-9]\d*$/) cancelBaseAmount: string;
}
export class TransitionReversalFactsDto {
  @ApiProperty({ enum: ['REVERSAL'] }) @IsIn(['REVERSAL']) action: 'REVERSAL';
  @ApiProperty({ type: [TransitionReversalAllocationDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TransitionReversalAllocationDto)
  allocations: TransitionReversalAllocationDto[];
}
export class TransitionResolutionItemDto {
  @ApiProperty() @Transform(normalizeText) @IsString() @IsNotEmpty() @MaxLength(32) prevStatus: string;
  @ApiProperty() @Transform(normalizeText) @IsString() @IsNotEmpty() @MaxLength(32) newStatus: string;
  @ApiProperty({ enum: ['PROVIDER', 'MANUAL'] }) @IsIn(['PROVIDER', 'MANUAL']) sourceEventIdOrigin:
    | 'PROVIDER'
    | 'MANUAL';
  @ApiPropertyOptional() @Transform(normalizeText) @IsOptional() @IsString() @MaxLength(255) sourceEventId?:
    | string
    | null;
  @ApiProperty()
  @Transform(normalizeText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  @Matches(/^[^\u0000-\u001F\u007F-\u009F]*$/u)
  providerEvidenceRef: string;
  @ApiProperty({ description: 'KST naive DATETIME(6)' })
  @Transform(normalizeText)
  @IsString()
  @IsNotEmpty()
  sourceOccurredAt: string;
  @ApiProperty({ description: 'KST naive DATETIME(6)' })
  @Transform(normalizeText)
  @IsString()
  @IsNotEmpty()
  occurredAt: string;
  @ApiProperty({
    oneOf: [
      { $ref: '#/components/schemas/TransitionForwardFactsDto' },
      { $ref: '#/components/schemas/TransitionReversalFactsDto' },
    ],
  })
  ledgerFacts: TransitionForwardFactsDto | TransitionReversalFactsDto;
}
export class TransitionResolutionProposeReqDto {
  @ApiProperty({ type: [TransitionResolutionItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TransitionResolutionItemDto)
  transitions: TransitionResolutionItemDto[];
  @ApiPropertyOptional() @Transform(normalizeText) @IsOptional() @IsString() @MaxLength(1000) reason?: string | null;
  @ApiProperty()
  @Transform(normalizeText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_-]+$/)
  requestKey: string;
}
export class TransitionResolutionApproveReqDto {
  @ApiPropertyOptional()
  @Transform(normalizeText)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  decisionReason?: string | null;
}

export class TransitionResolutionRejectReqDto {
  @ApiProperty()
  @Transform(normalizeText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}
