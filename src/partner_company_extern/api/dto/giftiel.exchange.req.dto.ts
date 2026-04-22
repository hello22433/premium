import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { GiftielExchangeCmdType } from '../../../entity/giftiel.exchange.history.entity';

/**
 * Giftiel push 수신 DTO
 *
 * Giftiel "교환정보전송가이드" 규격에 따라 PascalCase 필드로 수신.
 * UsePrice/BalPrice는 금액권(02)에서 소수 2자리로 올 수 있어 string으로 받음.
 */
export class GiftielExchangeReqDto {
  @IsString()
  @MaxLength(4)
  ServCode: string;

  @IsIn(['L1', 'L2'])
  CmdType: GiftielExchangeCmdType;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  UsePrice?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  BalPrice?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  CouponType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  BiCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  BiName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  AuthCode?: string;

  @IsString()
  @MaxLength(19)
  AuthDate: string;

  @IsString()
  @MaxLength(100)
  TrID: string;

  @IsString()
  @MaxLength(50)
  CouponNumber: string;

  @IsOptional()
  @IsString()
  @MaxLength(19)
  DateTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  ResultMsg?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4)
  ResultCode?: string;
}
