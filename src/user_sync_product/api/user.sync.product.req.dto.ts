import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IUserSyncProductStatus } from '../interface/user.sync.product.status';
import { dateAtRegexp } from '../../common/domain/date.regexp';

export class UserSyncProductGetListReqDto extends PagingReqDto {
  @ApiPropertyOptional({
    description: '검색 시작 일(등록일) ex) yyyy-MM-ddTHH:mm:ss',
  })
  @IsOptional()
  @Matches(dateAtRegexp)
  startAt?: string;

  @ApiPropertyOptional({
    description: '검색 끝 일(등록일) ex) yyyy-MM-ddTHH:mm:ss',
  })
  @IsOptional()
  @Matches(dateAtRegexp)
  endAt?: string;

  @ApiPropertyOptional({
    description: '고객사 명 ',
  })
  // ================================
  @IsOptional()
  businessUserName?: string;

  @ApiPropertyOptional({
    description: '운영상태 ex) ACTIVE: 사용, STOPPED: 일시중지, CLOSED: 종료',
  })
  // =================================
  @IsEnum(IUserSyncProductStatus)
  @IsOptional()
  status?: IUserSyncProductStatus;

  @ApiPropertyOptional({
    description: '이벤트 코드',
  })
  // =================================
  @IsOptional()
  code?: string;

  @ApiPropertyOptional({
    description: '이벤트 명',
  })
  // =================================
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({
    description: '상품명 (해당 상품이 매핑된 이벤트만 조회)',
  })
  // =================================
  @IsOptional()
  @IsString()
  productName?: string;

  @ApiPropertyOptional({
    description: '통합 검색 키워드 (이벤트코드, 이벤트명, 상품명 OR 검색)',
  })
  // =================================
  @IsOptional()
  @IsString()
  searchKeyword?: string;
}

export class UserSyncProductUpdateStatusReqDto {
  @ApiProperty({
    description: '이벤트 id',
  })
  // =================================
  @IsNumber()
  @IsNotEmpty()
  id: number;

  @ApiProperty({
    description: '운영 상태 ex) ACTIVE: 사용, STOPPED: 일시중지, CLOSED: 종료',
  })
  // =================================
  @IsNotEmpty()
  @IsEnum(IUserSyncProductStatus)
  status: IUserSyncProductStatus;
}

export class UserSyncProductGetDetailReqParamDto {
  @ApiProperty({
    description: '이벤트 id',
  })
  // =================================
  @Type(() => Number)
  @Min(1)
  @IsNotEmpty()
  id: number;
}

export class UserSyncProductRegisterEventReqDto {
  @ApiProperty({
    description: '고객사 user.id',
  })
  // =================================
  @IsNumber()
  userId: number;

  @ApiProperty({
    description: '담당자 name',
  })
  // =================================
  @IsString()
  userPersonName: string;

  // @ApiProperty({
  //   description: '담당자 user.id',
  // })
  // // =================================
  // @IsNumber()
  // adminUserId: number;

  @ApiProperty({
    description: '이벤트명',
  })
  // =================================
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: '이벤트 코드',
  })
  // =================================
  @IsNotEmpty()
  code: string;

  @ApiProperty({
    description: '운영 상태 ex) ACTIVE: 사용, STOPPED: 일시중지, CLOSED: 종료',
  })
  // =================================
  @IsNotEmpty()
  @IsEnum(IUserSyncProductStatus)
  status: IUserSyncProductStatus;

  @ApiProperty({
    description: '연락처 (-없이 숫자만)',
  })
  // =================================
  @IsNotEmpty()
  phone: string;

  @ApiProperty({
    description: '이메일',
  })
  // =================================
  @IsNotEmpty()
  email: string;
}

export class UserSyncProductInsertProductReqDto {
  @ApiProperty({
    description: '상품 등록할 연동 event id',
  })
  // =================================
  @IsNumber()
  @IsNotEmpty()
  eventId: number;

  @ApiProperty({
    description: '연동할 상품 id list',
  })
  // =================================
  @IsArray() // 배열 검증
  @IsInt({ each: true }) // 배열 내 값 number 검증
  @ArrayMinSize(1, { message: '추가할 상품 id 는 최소 1개 이상의 값이 필요합니다.' })
  productIdList: number[];
}

export class UserSyncProductDeleteProductReqDto {
  @ApiProperty({
    description: '연동 정보에서 삭제할 연동상품 mapping id',
  })
  // =================================
  @IsArray() // 배열 검증
  @IsInt({ each: true }) // 배열 내 값 number 검증
  @ArrayMinSize(1, { message: '삭제할 id 는 최소 1개 이상의 값이 필요합니다.' })
  idList: number[];
}

export class UserSyncProductSetHeadPersonReqDto {
  @ApiProperty({
    description: '기본 담당자로 설정할 user.id',
  })
  // =================================
  @IsNumber()
  @IsNotEmpty()
  userId: number;

  @ApiProperty({
    default: true,
    description: 'boolean 처리',
  })
  // =================================
  @IsBoolean()
  @IsNotEmpty()
  isHeadPerson: boolean = true;
}

export class UserSyncProductGetHeadPersonListReqQueryDto extends PagingReqDto {
  @ApiProperty({
    description: '고객상품 관리 고객사 user id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  userId: number;

  @ApiPropertyOptional({
    description: '검색 키워드 ex) 계정 email, 고객사 명',
  })
  // =================================
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({
    description: '담당자 명',
  })
  // =================================
  @IsOptional()
  @IsString()
  personName?: string;
}

export class UserSyncProductGetCustomersByProductReqParamDto {
  @ApiProperty({
    description: '상품 id',
  })
  // =================================
  @Type(() => Number)
  @Min(1)
  @IsNotEmpty()
  productId: number;
}

export class UserSyncProductGetPersonsByBusinessReqDto {
  @ApiProperty({
    description: '고객사 user.id',
  })
  // =================================
  @IsNumber()
  @Type(() => Number)
  @IsNotEmpty()
  userId: number;
}
