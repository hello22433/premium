import { Controller, Get, Post, Delete, Body, Param, Query, Req, UseGuards, UseFilters } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiSecurity } from '@nestjs/swagger';
import { Request } from 'express';

import { ExternalApiService } from '../application/external.api.service';
import { ApiKeyGuard } from './external.api.key.guard';
import { ExternalApiExceptionFilter } from './external.api.exception.filter';
import { CreateExternalOrderDto, CreateExternalSsgOrderDto, ExternalProductQueryDto } from './dto/external.api.request.dto';
import { UserEntity } from '../../entity/user.entity';

@Controller('api/v1/external')
@UseGuards(ApiKeyGuard)
@UseFilters(ExternalApiExceptionFilter)
@ApiTags('External API')
@ApiSecurity('api-key')
export class ExternalApiController {
  constructor(private readonly externalApiService: ExternalApiService) {}

  @Get('products')
  @ApiOperation({ summary: '상품 목록 조회' })
  async getProducts(@Req() req: Request, @Query() query: ExternalProductQueryDto) {
    return this.externalApiService.getProducts((req as any).apiUser as UserEntity, query.productCode);
  }

  @Post('orders')
  @ApiOperation({ summary: '쿠폰 발송 (즉시)' })
  async createOrder(@Req() req: Request, @Body() dto: CreateExternalOrderDto) {
    return this.externalApiService.createOrder((req as any).apiUser as UserEntity, dto);
  }

  @Post('orders/:trId/resend')
  @ApiOperation({ summary: '재발송' })
  async resendOrder(@Req() req: Request, @Param('trId') trId: string) {
    return this.externalApiService.resendOrder((req as any).apiUser as UserEntity, trId);
  }

  @Get('orders/:trId/status')
  @ApiOperation({ summary: '주문 상태 확인' })
  async getOrderStatus(@Req() req: Request, @Param('trId') trId: string) {
    return this.externalApiService.getOrderStatus((req as any).apiUser as UserEntity, trId);
  }

  @Delete('orders/:trId')
  @ApiOperation({ summary: '쿠폰 취소' })
  async cancelOrder(@Req() req: Request, @Param('trId') trId: string) {
    return this.externalApiService.cancelOrder((req as any).apiUser as UserEntity, trId);
  }

  @Post('orders/ssg')
  @ApiOperation({ summary: 'SSG 쿠폰 발송' })
  async createSsgOrder(@Req() req: Request, @Body() dto: CreateExternalSsgOrderDto) {
    return this.externalApiService.createSsgOrder((req as any).apiUser as UserEntity, dto);
  }

  @Get('orders/ssg/:trId/status')
  @ApiOperation({ summary: 'SSG 주문 상태 확인' })
  async getSsgOrderStatus(@Req() req: Request, @Param('trId') trId: string) {
    return this.externalApiService.getOrderStatus((req as any).apiUser as UserEntity, trId);
  }
}
