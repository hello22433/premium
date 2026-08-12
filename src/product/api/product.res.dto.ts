import { ProductViewDto } from './dto/product.view.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { ProductDetailDto } from './dto/product.detail.dto';
import { ProductHistoryViewDto } from './dto/product.history.view.dto';
import { ProductSsgDto } from './dto/product.ssg.dto';
import { ClassificationViewDto } from './dto/classification.view.dto';

export class ProductGetListResDto extends GetListResDto {
  @ApiProperty({
    type: [ProductViewDto],
    description: '상품 list',
  })
  list: ProductViewDto[];
}

export class ProductGetSsgResDto extends ProductSsgDto {}

export class ProductGetDetailResDto extends ProductDetailDto {}

export class ProductGetUpdateHistoryResDto extends GetListResDto {
  @ApiProperty({
    type: [ProductHistoryViewDto],
    description: '변경 내역 히스토리 list ',
  })
  list: ProductHistoryViewDto[];
}

export class ClassificationGetSearchListResDto extends GetListResDto {
  @ApiProperty({
    type: [ClassificationViewDto],
    description: '대분류 리스트',
  })
  list: ClassificationViewDto[];
}

export class ProductGetLinkAverageExpireDayResDto {
  @ApiPropertyOptional({
    description: '연동상품 유효기간 평균 (일). 연동상품 없으면 null',
    nullable: true,
  })
  averageExpireDay: number | null;
}

export class ProductSharedListFileResDto {
  @ApiPropertyOptional({
    description: '업로드 파일 id',
    nullable: true,
  })
  id: number | null;

  @ApiPropertyOptional({
    description: '업로드 파일명',
    nullable: true,
  })
  fileName: string | null;

  @ApiPropertyOptional({
    description: '업로드한 관리자 id',
    nullable: true,
  })
  userId: number | null;

  @ApiPropertyOptional({
    description: '업로드 일시',
    nullable: true,
  })
  createdAt: string | null;
}

export class ProductGetSsgNoticeResDto {
  @ApiProperty({
    description: '신세계 상품 유의사항 전문. 줄바꿈은 LF 로 통일되어 저장된 그대로 내려갑니다.',
  })
  notice: string;

  @ApiProperty({
    description: '이 문구를 사용하는 신세계 상품(권종) 수',
  })
  productCount: number;

  @ApiProperty({
    description:
      '권종별로 서로 다른 문구가 몇 종류인지. 정상 상태는 1 이며, 2 이상이면 과거 데이터가 갈라진 것이고 저장하면 전부 하나로 맞춰집니다.',
  })
  distinctNoticeCount: number;

  @ApiProperty({
    description: '유의사항 바이트 수(UTF-8). 문자 발송 분량을 가늘하는 참고값입니다.',
  })
  noticeByteLength: number;

  @ApiPropertyOptional({
    description: '마지막으로 유의사항을 수정한 일시. 수정 이력이 없으면 null',
    nullable: true,
  })
  lastUpdatedAt: string | null;

  @ApiPropertyOptional({
    description: '마지막으로 유의사항을 수정한 관리자. 수정 이력이 없으면 null',
    nullable: true,
  })
  lastUpdatedUserName: string | null;
}
