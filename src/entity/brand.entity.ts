import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../common/entity/base.entity';

@Entity('brand')
export class BrandEntity extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 20, unique: true, comment: '브랜드 코드' })
  code: string;

  @Column({ type: 'varchar', length: 200, comment: '브랜드 이름 한글' })
  nameKorean: string;

  @Column({ type: 'varchar', length: 200, comment: '브랜드 이름 영문' })
  nameEnglish: string;

  @Column({ comment: '사용 유무 ' })
  isUsed: boolean;
}
