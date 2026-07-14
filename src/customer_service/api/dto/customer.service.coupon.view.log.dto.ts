import { ApiProperty } from '@nestjs/swagger';

/**
 * coupon-view 페이지 방문 로그 1건 (CS 상세 화면 표시용).
 */
export class CouponViewLogItemDto {
  @ApiProperty({ description: '방문 시각 ex)yyyy-MM-ddTHH:mm:ss' })
  visitedAt: string;

  @ApiProperty({ description: '방문자 IP', nullable: true })
  ipAddress: string | null;

  @ApiProperty({ description: 'User-Agent 원문', nullable: true })
  userAgent: string | null;

  @ApiProperty({ description: '진입 경로 (alimtalk: 알림톡)' })
  source: string;

  @ApiProperty({ description: '알려진 크롤러/미리보기 봇 UA 여부 (true=봇, 실제 방문 아님)' })
  isBot: boolean;
}

/**
 * coupon-view 방문 로그 조회 응답 (집계 + 상한 목록).
 * 응답 크기를 제한하기 위해 items 는 최신 N건만 담고, 전체 규모는 집계 필드로 제공한다.
 */
export class CouponViewLogResDto {
  @ApiProperty({ description: '전체 방문 수(봇 포함)' })
  total: number;

  @ApiProperty({ description: '실제 방문 수(봇 제외)' })
  humanCount: number;

  @ApiProperty({ description: '봇/미리보기 방문 수' })
  botCount: number;

  @ApiProperty({ description: '최초 실제(봇 제외) 방문 시각', nullable: true })
  firstHumanVisitedAt: string | null;

  @ApiProperty({ description: '마지막 방문 시각(봇 포함)', nullable: true })
  lastVisitedAt: string | null;

  @ApiProperty({ type: [CouponViewLogItemDto], description: '최신순 방문 목록(최대 100건)' })
  items: CouponViewLogItemDto[];
}
