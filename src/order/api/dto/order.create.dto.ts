import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsOptional, IsString, Matches } from 'class-validator';
import { IOrderSendMethod } from '../../interface/order.send.method';
import { dateAtRegexp } from '../../../common/domain/date.regexp';
import { Transform, Type } from 'class-transformer';
import { OrderProductCreateTempDto } from './order.product.create.temp.dto';
import { OrderEmailSendType } from '../../domain/order.email.send.type';

export class OrderCreateDto {
  @ApiProperty({
    description: '이벤트 명',
    default: '',
  })
  // =================================================
  @IsString()
  eventName: string;

  @ApiProperty({
    description: '전송 방식 ex) 알림톡: ALIM_TALK, 문자: SMS, 이메일: EMAIL',
    default: 'ALIM_TALK',
  })
  // =================================================
  @IsEnum(IOrderSendMethod)
  sendMethod: IOrderSendMethod;

  @ApiPropertyOptional({
    description: '꼬리 광고 텍스트',
  })
  // =================================================
  @IsOptional()
  sendTailText: string | null;

  @ApiPropertyOptional({
    description: '개인정보 파기 요청 일',
  })
  // =================================================
  // @IsNumber()
  @Transform(({ value }) => (typeof value === 'number' ? +value : 0))
  @IsOptional()
  @Type(() => Number)
  requestToDestroyPersonalInfoDay: number = 0;

  @ApiPropertyOptional({
    description: '발신 번호',
  })
  // =================================================
  @IsOptional()
  @IsString()
  fromPhoneNumber: string | null = '16443614';

  @ApiPropertyOptional({
    description: '발신 이메일',
  })
  // =================================================
  @IsOptional()
  @IsString()
  fromEmail: string | null;

  @ApiPropertyOptional({
    description: 'QR: QR, URL: URL',
  })
  // =================================================
  @IsOptional()
  @IsEnum(OrderEmailSendType)
  @Transform(({ value }) => (value === '' ? null : value)) // 빈 문자열을 null로 변환
  emailSendType: OrderEmailSendType | null = null;

  @ApiProperty({
    description: '발신 제목',
    default: '',
  })
  // =================================================
  @IsString()
  sendTitle: string;

  @ApiProperty({
    description: '발신 내용',
    default: '',
  })
  // =================================================
  @IsString()
  sendContent: string;

  @ApiProperty({
    description: '이메일시 사용 방법',
    default: '',
  })
  // =================================================
  @IsOptional()
  @IsString()
  useEmailContent: string | null = null;

  @ApiPropertyOptional({
    description: '미리보기 상단 이미지 url, 없으면 기본 이미지 사용',
  })
  // =================================================
  @IsOptional()
  topImagePath?: string | null;

  @ApiPropertyOptional({
    description: '미리보기 중간 이미지 url, 없으면 기본 이미지 사용',
  })
  // =================================================
  @IsOptional()
  midImagePath?: string | null;

  @ApiPropertyOptional({
    description: '발신 시간',
    default: '1970-01-01T00:00:00',
  })
  // =================================================
  // @IsNotEmpty()
  @IsOptional()
  @Matches(dateAtRegexp)
  sendRequestAt: string = '1970-01-01T00:00:00';

  @ApiPropertyOptional({
    description: '발송 방식',
  })
  // =================================================
  @IsOptional()
  @IsString()
  sendType: string | null;

  @ApiProperty({
    description: '상품 수량',
  })
  // =================================
  @IsArray() // 배열임을 검증
  @Type(() => OrderProductCreateTempDto)
  orderProductList: OrderProductCreateTempDto[];
}
