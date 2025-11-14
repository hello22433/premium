import { ApiProperty } from '@nestjs/swagger';

export class ActivityLogViewDto {
  @ApiProperty({ description: 'ID' })
  id: number;

  @ApiProperty({ description: '생성일시' })
  createdAt: string;

  @ApiProperty({ description: '사용자 이메일' })
  userEmail: string;

  @ApiProperty({ description: 'HTTP 메소드' })
  method: string;

  @ApiProperty({ description: '요청 URL' })
  requestUrl: string;

  @ApiProperty({ description: '액션 타입' })
  actionType: string;

  @ApiProperty({ description: 'IP 주소' })
  ipAddress: string;

  @ApiProperty({ description: 'User Agent', nullable: true })
  userAgent: string | null;

  @ApiProperty({ description: 'HTTP 상태 코드' })
  statusCode: number;

  @ApiProperty({ description: '결과 (O: 성공, X: 실패)' })
  result: string;

  @ApiProperty({ description: '응답 시간 (ms)' })
  responseTime: number;

  @ApiProperty({ description: '다운로드 사유', nullable: true })
  downloadReason: string | null;

  @ApiProperty({ description: '레코드 수', nullable: true })
  recordCount: number | null;

  @ApiProperty({ description: '요청 파라미터', nullable: true })
  requestParams: any;

  @ApiProperty({ description: '에러 메시지', nullable: true })
  errorMessage: string | null;
}

export class GetActivityLogListResDto {
  @ApiProperty({ type: [ActivityLogViewDto], description: '로그 목록' })
  list: ActivityLogViewDto[];

  @ApiProperty({ description: '전체 개수' })
  totalCount: number;

  @ApiProperty({ description: '전체 페이지 수' })
  totalPage: number;

  @ApiProperty({ description: '현재 페이지' })
  currentPage: number;
}

export class GetActionTypesResDto {
  @ApiProperty({ type: [String], description: 'action_type 목록' })
  actionTypes: string[];
}
