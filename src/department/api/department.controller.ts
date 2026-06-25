import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DepartmentService } from '../application/department.service';
import {
  DepartmentCreateReqDto,
  DepartmentGetListReqDto,
  DepartmentUpdateReqDto,
  UserDepartmentUpdateReqDto,
  ViewScopeUpdateReqDto,
} from './department.req.dto';
import { DepartmentGetDetailResDto, DepartmentGetListResDto, ViewScopeGetResDto } from './department.res.dto';
import { AuthUserSuperAdminGuard } from '../../auth/api/auth.user.super-admin.guard';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';

@ApiTags('department')
@Controller('')
export class DepartmentController {
  constructor(private departmentService: DepartmentService) {}

  // ============================================
  // 부서 CRUD
  // ============================================

  @ApiOperation({
    summary: '부서 목록 조회 API',
    description: '회사별 부서 목록을 조회합니다. companyId를 입력하지 않으면 전체를 조회합니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: DepartmentGetListResDto,
    description: '성공적으로 조회한 경우',
  })
  @UseGuards(AuthUserAuthorizationGuard)
  @Get('/department/list')
  getDepartmentList(@Query() dto: DepartmentGetListReqDto): Promise<DepartmentGetListResDto> {
    return this.departmentService.getDepartmentList(dto);
  }

  @ApiOperation({
    summary: '부서 상세 조회 API',
    description: '부서 상세 정보와 소속 사용자 목록을 조회합니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: DepartmentGetDetailResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '부서를 찾을 수 없는 경우',
  })
  @UseGuards(AuthUserAuthorizationGuard)
  @Get('/department/:id')
  getDepartmentDetail(@Param('id', ParseIntPipe) id: number): Promise<DepartmentGetDetailResDto> {
    return this.departmentService.getDepartmentDetail(id);
  }

  @ApiOperation({
    summary: '부서 생성 API',
    description: '새 부서를 생성합니다. (최고관리자 전용)',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 생성한 경우',
  })
  @ApiBadRequestResponse({
    description: '동일한 부서명이 이미 존재하는 경우',
  })
  @UseGuards(AuthUserSuperAdminGuard)
  @Post('/department')
  createDepartment(@Body() dto: DepartmentCreateReqDto): Promise<void> {
    return this.departmentService.createDepartment(dto);
  }

  @ApiOperation({
    summary: '부서 수정 API',
    description: '부서 정보를 수정합니다. (최고관리자 전용)',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 수정한 경우',
  })
  @ApiBadRequestResponse({
    description: '부서를 찾을 수 없거나 동일한 부서명이 이미 존재하는 경우',
  })
  @UseGuards(AuthUserSuperAdminGuard)
  @Put('/department')
  updateDepartment(@Body() dto: DepartmentUpdateReqDto): Promise<void> {
    return this.departmentService.updateDepartment(dto);
  }

  @ApiOperation({
    summary: '부서 삭제 API',
    description: '부서를 삭제합니다. 소속 사용자가 있으면 삭제할 수 없습니다. (최고관리자 전용)',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 삭제한 경우',
  })
  @ApiBadRequestResponse({
    description: '부서를 찾을 수 없거나 소속 사용자가 존재하는 경우',
  })
  @UseGuards(AuthUserSuperAdminGuard)
  @Delete('/department/:id')
  deleteDepartment(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.departmentService.deleteDepartment(id);
  }

  // ============================================
  // 사용자 부서 배정
  // ============================================

  @ApiOperation({
    summary: '사용자 부서 배정 API',
    description: '사용자를 특정 부서에 배정합니다. (최고관리자 전용)',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 배정한 경우',
  })
  @ApiBadRequestResponse({
    description: '사용자 또는 부서를 찾을 수 없는 경우',
  })
  @UseGuards(AuthUserSuperAdminGuard)
  @Put('/department/user')
  updateUserDepartment(@Body() dto: UserDepartmentUpdateReqDto): Promise<void> {
    return this.departmentService.updateUserDepartment(dto);
  }

  // ============================================
  // 조회 범위 설정
  // ============================================

  @ApiOperation({
    summary: '사용자 조회 범위 조회 API',
    description: '특정 사용자의 조회 범위 설정을 조회합니다.',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    type: ViewScopeGetResDto,
    description: '성공적으로 조회한 경우',
  })
  @ApiBadRequestResponse({
    description: '사용자를 찾을 수 없는 경우',
  })
  @UseGuards(AuthUserAuthorizationGuard)
  @Get('/view-scope/:userId')
  getViewScope(@Param('userId', ParseIntPipe) userId: number): Promise<ViewScopeGetResDto> {
    return this.departmentService.getViewScope(userId);
  }

  @ApiOperation({
    summary: '사용자 조회 범위 설정 API',
    description: '특정 사용자의 조회 범위를 설정합니다. (최고관리자 전용)',
  })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: '성공적으로 설정한 경우',
  })
  @ApiBadRequestResponse({
    description: '사용자를 찾을 수 없는 경우',
  })
  @UseGuards(AuthUserSuperAdminGuard)
  @Put('/view-scope')
  updateViewScope(@Body() dto: ViewScopeUpdateReqDto): Promise<void> {
    return this.departmentService.updateViewScope(dto);
  }
}
