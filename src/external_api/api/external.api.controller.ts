import { Controller, Get, Post, Delete, Body, Param, Query, Req, UseGuards, UseFilters, UseInterceptors, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiSecurity } from '@nestjs/swagger';
import { Request } from 'express';

import { ExternalApiService } from '../application/external.api.service';
import { ApiKeyGuard } from './external.api.key.guard';
import { ExternalApiThrottleGuard } from './external.api.throttle.guard';
import { ExternalApiExceptionFilter } from './external.api.exception.filter';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { CreateExternalOrderDto, CreateExternalSsgOrderDto, ExternalProductQueryDto } from './dto/external.api.request.dto';
import { ExternalApiAccountEntity } from '../../entity/external.api.account.entity';

@Controller('api/v1/external')
@UseGuards(ApiKeyGuard, ExternalApiThrottleGuard)
@UseFilters(ExternalApiExceptionFilter)
@ApiTags('External API')
@ApiSecurity('api-key')
export class ExternalApiController {
  constructor(private readonly externalApiService: ExternalApiService) {}

  private getAccount(req: Request): ExternalApiAccountEntity {
    return (req as any).apiAccount as ExternalApiAccountEntity;
  }

  @Get('products')
  @ApiOperation({ summary: '상품 목록 조회' })
  async getProducts(@Req() req: Request, @Query() query: ExternalProductQueryDto) {
    return this.externalApiService.getProducts(this.getAccount(req), query.productCode);
  }

  @Post('orders')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: '쿠폰 발송 (즉시)' })
  async createOrder(@Req() req: Request, @Body() dto: CreateExternalOrderDto) {
    return this.externalApiService.createOrder(this.getAccount(req), dto);
  }

  @Post('orders/:trId/resend')
  @HttpCode(200)
  @ApiOperation({ summary: '재발송' })
  async resendOrder(@Req() req: Request, @Param('trId') trId: string) {
    return this.externalApiService.resendOrder(this.getAccount(req), trId);
  }

  @Get('orders/:trId/status')
  @ApiOperation({ summary: '주문 상태 확인' })
  async getOrderStatus(@Req() req: Request, @Param('trId') trId: string) {
    return this.externalApiService.getOrderStatus(this.getAccount(req), trId);
  }

  @Delete('orders/:trId')
  @ApiOperation({ summary: '쿠폰 취소' })
  async cancelOrder(@Req() req: Request, @Param('trId') trId: string) {
    return this.externalApiService.cancelOrder(this.getAccount(req), trId);
  }

  @Post('orders/ssg')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'SSG 쿠폰 발송' })
  async createSsgOrder(@Req() req: Request, @Body() dto: CreateExternalSsgOrderDto) {
    return this.externalApiService.createSsgOrder(this.getAccount(req), dto);
  }

  @Get('orders/ssg/:trId/status')
  @ApiOperation({ summary: 'SSG 주문 상태 확인' })
  async getSsgOrderStatus(@Req() req: Request, @Param('trId') trId: string) {
    return this.externalApiService.getSsgOrderStatus(this.getAccount(req), trId);
  }
}
