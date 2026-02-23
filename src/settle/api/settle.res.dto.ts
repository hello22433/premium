import { GetListResDto } from '../../common/api/dto/get.list.res.dto';
import { SettleUserListViewDto } from './dto/settle.user.list.view.dto';
import { ApiProperty } from '@nestjs/swagger';
import { SettlePartnerCompanyListViewDto } from './dto/settle.partner.company.list.view.dto';
import { SettleMobileListViewDto } from './dto/settle.mobile.list.view.dto';
import { SettleUserDetailDto } from './dto/settle.user.detail.dto';
import { SettleUserDetailMultipleDto } from './dto/settle.user.detail.multiple.dto';
import { SettleOtherViewDto } from './dto/settle.other.view.dto';
import { ShippingStorageViewDto } from './dto/shipping.storage.view.dto';
import { SaleTypeViewDto } from './dto/sale.type.view.dto';
import { AdminListViewDto } from './dto/admin.list.view.dto';
import { SettleOtherDetailDto } from './dto/settle.other.detail.dto';
import { SettleUserPerListViewDto } from './dto/settle.user.per.list.view.dto';
import { SettleUserPerDetailViewDto } from './dto/settle.user.per.detail.view.dto';
import { SettleGalaxiaListViewDto } from './dto/settle.galaxia.list.view.dto';

export class SettleGetOtherListResDto extends GetListResDto {
  @ApiProperty({
    description: '기타 서비스 매출 데이터 list',
  })
  list: SettleOtherViewDto[];
}

export class SettleGetOtherDetailResDto extends SettleOtherDetailDto {}

export class SettleGetShippingStorageListResDto extends GetListResDto {
  @ApiProperty({
    description: '창고 데이터 list',
  })
  list: ShippingStorageViewDto[];
}

export class SettleGetSaleTypeListResDto extends GetListResDto {
  @ApiProperty({
    description: '판매유형 데이터 list',
  })
  list: SaleTypeViewDto[];
}

export class SettleGetAdminUserListResDto extends GetListResDto {
  @ApiProperty({
    description: '담당자 list',
  })
  list: AdminListViewDto[];
}

export class SettleGetMobileListResDto extends GetListResDto {
  @ApiProperty({
    description: '고객사별 정산 데이터 list',
  })
  list: SettleMobileListViewDto[];
}

export class SettleGetUserListResDto extends GetListResDto {
  @ApiProperty({
    description: '고객사별 정산 데이터 list',
  })
  list: SettleUserListViewDto[];

  @ApiProperty({
    description: '검색 조건 전체의 총 발송수량 합계 (페이지 무관)',
  })
  totalAmountSum: number;

  @ApiProperty({
    description: '검색 조건 전체의 총 발송금액 합계',
  })
  totalDeliveryPriceSum: number;

  @ApiProperty({
    description: '검색 조건 전체의 총 정산금액 합계',
  })
  totalSettlePriceSum: number;
}

export class SettleGetUserDetailResDto extends SettleUserDetailDto {}

export class SettleGetUserDetailMultipleResDto extends SettleUserDetailMultipleDto {}

export class SettleGetUserIdsItemDto {
  @ApiProperty({ description: '주문 ID' })
  id: number;

  @ApiProperty({ description: '정산금액 (할인 적용)' })
  settlePrice: number;

  @ApiProperty({ description: '고객사 명' })
  businessName: string;

  @ApiProperty({ description: '고객사 ID' })
  companyId: number;
}

export class SettleGetUserIdsResDto {
  @ApiProperty({
    description: '주문 ID + 메타정보 목록',
    type: [SettleGetUserIdsItemDto],
  })
  items: SettleGetUserIdsItemDto[];

  @ApiProperty({ description: '전체 건수' })
  totalCount: number;
}

export class SettleGetPartnerCompanyListResDto extends GetListResDto {
  @ApiProperty({
    description: '고객사별 정산 데이터 list',
  })
  list: SettlePartnerCompanyListViewDto[];
}

export class SettleGetPerUserListResDto extends GetListResDto {
  @ApiProperty({
    description: '정산관리 list',
  })
  list: SettleUserPerListViewDto[];
}

export class SettleGetPerUserDetailResDto extends GetListResDto {
  @ApiProperty({
    description: '정산관리 detail list',
  })
  list: SettleUserPerDetailViewDto[];
}

export class SettleGetGalaxiaListResDto extends GetListResDto {
  @ApiProperty({
    description: '갤럭시아 사용내역 list',
  })
  list: SettleGalaxiaListViewDto[];
}

export class SettleGetRemainServiceAmountResDto {
  @ApiProperty({
    description: '최대 서비스 한도',
    example: 10000000,
  })
  maximumLimit: number;

  @ApiProperty({
    description: '선입금 금액',
    example: 5000000,
  })
  balance: number;

  @ApiProperty({
    description: '서비스 금액 (미정산 금액)',
    example: 3000000,
  })
  serviceAmount: number;

  @ApiProperty({
    description: '정산기일 초과 금액',
    example: 500000,
  })
  overdueAmount: number;

  @ApiProperty({
    description: '정산 금액',
    example: 2000000,
  })
  allSettleAmount: number;

  @ApiProperty({
    description: '잔여 발송 한도',
    example: 13500000,
  })
  remainServiceAmount: number;
}
