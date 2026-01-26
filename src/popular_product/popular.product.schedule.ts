import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PopularProductService } from './application/popular.product.service';

@Injectable()
export class PopularProductSchedule {
  constructor(private popularProductService: PopularProductService) {}

  private logger = new Logger('PopularProductSchedule');

  // 매일 07:00에 실행
  @Cron('0 0 7 * * *')
  async handleCalculatePopularProducts(): Promise<void> {
    try {
      this.logger.log('Starting popular products calculation...');
      await this.popularProductService.calculateAndSave();
      this.logger.log('Popular products calculation completed');
    } catch (e) {
      this.logger.error('Failed to calculate popular products', e);
    }
  }
}