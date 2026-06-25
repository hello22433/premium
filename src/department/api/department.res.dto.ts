import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ViewScopeType } from '../../entity/user.view.scope.entity';

// ============================================
// 부서 관련 Response DTO
// ============================================

export class DepartmentViewDto {
  @ApiProperty({ description: '부서 ID' })
  id: number;

  @ApiProperty({ description: '회사 ID' })
  companyId: number;

  @ApiProperty({ description: '회사명' })
  companyName: string;

  @ApiProperty({ description: '부서명' })
  name: string;

  @ApiProperty({ description: '소속 인원 수' })
  userCount: number;

  @ApiProperty({ description: '생성일' })
  createdAt: string;
}

export class DepartmentGetListResDto {
  @ApiProperty({ description: '부서 목록', type: [DepartmentViewDto] })
  list: DepartmentViewDto[];
}

export class DepartmentUserViewDto {
  @ApiProperty({ description: '사용자 ID' })
  id: number;

  @ApiProperty({ description: '이메일' })
  email: string;

  @ApiProperty({ description: '담당자명' })
  personName: string;
}

export class DepartmentGetDetailResDto extends DepartmentViewDto {
  @ApiProperty({ description: '소속 사용자 목록', type: [DepartmentUserViewDto] })
  users: DepartmentUserViewDto[];
}

// ============================================
// 조회 범위 관련 Response DTO
// ============================================

export class ViewScopeDepartmentViewDto {
  @ApiProperty({ description: '부서 ID' })
  id: number;

  @ApiProperty({ description: '부서명' })
  name: string;

  @ApiProperty({ description: '회사명' })
  companyName: string;
}

export class ViewScopeGetResDto {
  @ApiProperty({ description: '사용자 ID' })
  userId: number;

  @ApiProperty({
    description: '조회 범위 타입',
    enum: ViewScopeType,
  })
  scopeType: ViewScopeType;

  @ApiPropertyOptional({
    description: '추가 조회 가능 부서 ID 목록',
    type: [Number],
  })
  deptIds: number[];

  @ApiPropertyOptional({
    description: '추가 조회 가능 부서 정보 목록',
    type: [ViewScopeDepartmentViewDto],
  })
  departments: ViewScopeDepartmentViewDto[];
}
