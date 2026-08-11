import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { IOrderSendMethod } from '../../interface/order.send.method';
import { OrderEmailSendType } from '../../domain/order.email.send.type';
import { OrderEmailFinalSendMethod } from '../../domain/order.email.final.send.method';
import { dateAtRegexp } from '../../../common/domain/date.regexp';
import { NormalizeMemo } from './order.manual.entry.dto';

export class OrderProductCreateTempDto {
  @ApiPropertyOptional({
    description: 'order product mapping 의 id ',
  })
  @IsOptional()
  @IsNumber()
  id?: number;

  @ApiProperty({
    description: 'product.id',
  })
  @IsNotEmpty()
  @IsNumber()
  productId: number;

  @ApiProperty({
    description: '상품 수량',
  })
  @IsNotEmpty()
  @IsNumber()
  amount: number;

  @ApiPropertyOptional({
    description: '전송 방식 ex) 알림톡: ALIM_TALK, 문자: MMS, 이메일: EMAIL',
  })
  @IsEnum(IOrderSendMethod)
  @IsOptional()
  sendMethod: IOrderSendMethod | null;

  @ApiPropertyOptional({
    description: '꼬리 광고 텍스트',
  })
  @IsOptional()
  sendTailText: string | null;

  @ApiPropertyOptional({
    description: '개인정보 파기 요청 일',
  })
  @IsNumber()
  @IsOptional()
  requestToDestroyPersonalInfoDay: number | null;

  @ApiPropertyOptional({
    description: '발신 번호',
  })
  @IsOptional()
  @IsString()
  fromPhoneNumber: string | null;

  @ApiPropertyOptional({
    description: '발신 이메일',
  })
  @IsOptional()
  @IsString()
  fromEmail: string | null;

  @ApiPropertyOptional({
    description: '전송 제목',
  })
  @IsOptional()
  @IsString()
  sendTitle: string | null;

  @ApiPropertyOptional({
    description: 'QR: QR, URL: URL',
  })
  @IsOptional()
  @IsEnum(OrderEmailSendType)
  @Transform(({ value }) => (value === '' ? null : value)) // 빈 문자열을 null로 변환
  emailSendType: OrderEmailSendType | null = null;
  @ApiPropertyOptional({
    description: '이메일 쿠폰 최종 발신 수단(ALIM_TALK|MMS). NULL=레거시(현행 알림톡 우선)',
  })
  @IsOptional()
  @IsEnum(OrderEmailFinalSendMethod)
  @Transform(({ value }) => (value === '' ? null : value))
  emailFinalSendMethod: OrderEmailFinalSendMethod | null = null;

  @ApiProperty({
    description: '이메일 사용 방법',
  })
  @IsOptional()
  @IsString()
  useEmailContent: string | null;

  @ApiPropertyOptional({
    description: '전송 내용',
  })
  @IsString()
  @IsOptional()
  sendContent: string | null;

  @ApiPropertyOptional({
    description: '발송 요청 시각 ex) yyyy-MM-ddTHH:mm:ss',
    nullable: true,
  })
  @IsOptional()
  @Matches(dateAtRegexp)
  sendRequestAt: string | null;

  @ApiProperty({
    description: '발송 방식 ex) IMMEDIATE : 즉시, RESERVE : 예약',
  })
  @IsOptional()
  @IsIn(['IMMEDIATE', 'RESERVE'])
  sendType: string | null;

  @ApiPropertyOptional({
    description: '독려 문자 day (만료일 N일 전 발송, null이면 미사용)',
  })
  @IsOptional()
  @IsNumber()
  encourageDay: number | null;

  @ApiProperty({
    description: '수신자 정보 list',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderDeliveryCreateDto)
  orderDeliveryList: OrderDeliveryCreateDto[];
}

export class OrderDeliveryCreateDto {
  @ApiProperty({
    description: '전송 주체 EMAIL 일 경우 email, SMS, ALIM_TALK 일 경우 핸드폰 번호',
  })
  @IsNotEmpty()
  @IsString()
  deliveryTarget: string;

  @ApiPropertyOptional({
    description: '대치문자 1 문구',
  })
  @IsOptional()
  replaceCharacter1?: string;

  @ApiPropertyOptional({
    description: '대치문자 2 문구',
  })
  @IsOptional()
  replaceCharacter2?: string;

  @ApiPropertyOptional({
    description: '대치문자 3 문구',
  })
  @IsOptional()
  replaceCharacter3?: string;

  @ApiPropertyOptional({ description: '수신자별 운영자 메모 (고객 미노출)', maxLength: 500, nullable: true })
  @NormalizeMemo()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  memo?: string | null;
}
