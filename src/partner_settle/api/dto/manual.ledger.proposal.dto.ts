import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
const text = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.normalize('NFC').trim() : value);
export class ManualLedgerProposalProposeReqDto {
  @ApiProperty() @Transform(text) @IsString() @IsNotEmpty() @MaxLength(24) provider: string;
  @ApiProperty() @IsInt() @Min(1) inboxRowId: number;
  @ApiPropertyOptional({ enum: ['LEDGER', 'DISCARD'], default: 'LEDGER' })
  @IsOptional()
  @IsIn(['LEDGER', 'DISCARD'])
  resolutionMode?: 'LEDGER' | 'DISCARD';
  @ApiPropertyOptional() @IsOptional() @IsObject() proposedLedgerFacts?: Record<string, unknown> | null;
  @ApiProperty()
  @Transform(text)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  @Matches(/^[^\u0000-\u001F\u007F-\u009F]*$/u)
  evidenceRef: string;
  @ApiProperty() @Transform(text) @IsString() @IsNotEmpty() @MaxLength(500) reason: string;
  @ApiProperty()
  @Transform(text)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_-]+$/)
  requestKey: string;
}
export class ManualLedgerProposalApproveReqDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(text)
  @IsString()
  @MaxLength(1000)
  decisionReason?: string;
}
export class ManualLedgerProposalRejectReqDto {
  @ApiProperty()
  @Transform(text)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}
