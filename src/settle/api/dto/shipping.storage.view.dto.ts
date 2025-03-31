import { ApiProperty } from '@nestjs/swagger';
import { IShippingStorageType } from '../../../entity/shipping.storage.entity';

export class ShippingStorageViewDto {
  @ApiProperty({
    description: 'id',
  })
  id: number;

  @ApiProperty({
    description: '타입 ex) STORAGE: 창고, FACTORY: 공장, OUTSOURCING_FACTORY: 공장(외주비관리)',
  })
  type: IShippingStorageType;

  @ApiProperty({
    description: '코드',
  })
  code: string;

  @ApiProperty({
    description: '이름',
  })
  name: string;
}
