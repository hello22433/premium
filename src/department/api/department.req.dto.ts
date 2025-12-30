import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { ViewScopeType } from '../../entity/user.view.scope.entity';

// ============================================
// 부서 관련 DTO
// ============================================

export class DepartmentCreateReqDto {
  @ApiProperty({ description: '회사 ID' })
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  companyId: number;

  @ApiProperty({ description: '부서명' })
  @IsNotEmpty()
  @IsString()
  name: string;
}

export class DepartmentUpdateReqDto {
  @ApiProperty({ description: '부서 ID' })
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;

  @ApiProperty({ description: '부서명' })
  @IsNotEmpty()
  @IsString()
  name: string;
}

export class DepartmentDeleteReqDto {
  @ApiProperty({ description: '부서 ID' })
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class DepartmentGetListReqDto {
  @ApiPropertyOptional({ description: '회사 ID (미입력 시 전체 조회)' })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  companyId?: number;
}

export class DepartmentGetDetailReqDto {
  @ApiProperty({ description: '부서 ID' })
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

// ============================================
// 조회 범위 관련 DTO
// ============================================

export class ViewScopeGetReqDto {
  @ApiProperty({ description: '사용자 ID' })
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  userId: number;
}

export class ViewScopeUpdateReqDto {
  @ApiProperty({ description: '사용자 ID' })
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  userId: number;

  @ApiProperty({
    description: '조회 범위 타입',
    enum: ViewScopeType,
    example: ViewScopeType.SELF,
  })
  @IsNotEmpty()
  @IsEnum(ViewScopeType)
  scopeType: ViewScopeType;

  @ApiPropertyOptional({
    description: '추가 조회 가능 부서 ID 목록 (DEPARTMENT 타입일 때 사용)',
    type: [Number],
    example: [1, 2, 3],
  })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  @Type(() => Number)
  deptIds?: number[];
}

export class UserDepartmentUpdateReqDto {
  @ApiProperty({ description: '사용자 ID' })
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  userId: number;

  @ApiPropertyOptional({ description: '부서 ID (null 가능)' })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  departmentId?: number | null;
}