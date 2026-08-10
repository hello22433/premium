import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUserAuthorizationGuard } from '../../auth/api/auth.user.authorization.guard';
import { User } from '../../auth/api/user.decorator';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { AuthService } from '../../auth/application/auth.service';
import { UserAuthSubEnum } from '../../user_management/domain/user.auth.enum';
import { PartnerDiscountReservationService } from '../application/partner.discount.reservation.service';
import { ReservationCreateReqDto, ReservationQueryDto } from './dto/discount.reservation.dto';

/**
 * 정산조건(할인율) 예약 조회·생성·취소 (정본 §9 · PR3B).
 *
 * 권한은 여신 조회(`SETTLE_CREDIT`)·정산확정(`SETTLE_PARTNER_CONFIRM`)과 분리된 `SETTLE_DISCOUNT` 다 —
 * 정산조건은 원장 금액에 직접 영향한다.
 *
 * 예약 **수정** endpoint 는 두지 않는다. 내용을 바꾸려면 취소하고 다시 예약한다(정본 §13 API 경계).
 */
@Controller('')
@ApiTags('settle/discount')
@ApiBearerAuth()
@UseGuards(AuthUserAuthorizationGuard)
export class DiscountReservationController {
  constructor(
    private readonly reservationService: PartnerDiscountReservationService,
    private readonly authService: AuthService,
  ) {}

  @ApiOperation({ summary: '정산조건 예약 목록' })
  @Get('settle/discount/reservations')
  async findReservations(@User() user: ILoginUserInfo, @Query() query: ReservationQueryDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_DISCOUNT);
    return this.reservationService.findReservations(query);
  }

  @ApiOperation({ summary: '정산조건 예약 생성' })
  @Post('settle/discount/reservations')
  async createReservation(@User() user: ILoginUserInfo, @Body() dto: ReservationCreateReqDto) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_DISCOUNT);
    return this.reservationService.createReservation(dto, user.id);
  }

  @ApiOperation({ summary: '정산조건 예약 취소 (PENDING · BLOCKED)' })
  @Delete('settle/discount/reservations/:id')
  async cancelReservation(@User() user: ILoginUserInfo, @Param('id', ParseIntPipe) id: number) {
    await this.authService.authorityValidator(user, UserAuthSubEnum.SETTLE_DISCOUNT);
    return this.reservationService.cancelReservation(id);
  }
}
