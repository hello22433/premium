import { PagingReqDto } from '../../common/api/dto/pagination.req.dto';
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { IUserDriveStatus } from '../interface/user.drive.status';

export class UserDriveGetListReqDto extends PagingReqDto {}

export class UserDriveGetDetailReqParamDto {
  @ApiProperty({
    description: 'user drive id',
  })
  // =================================
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  id: number;
}

export class UserDriveCreateReqDto {
  @ApiProperty({
    description: '수신 받을 user id',
  })
  // =================================
  @IsNotEmpty()
  @Min(1)
  receiverId: number;

  @ApiProperty({
    description: '제목',
  })
  // =================================
  @IsNotEmpty()
  title: string;

  @ApiProperty({
    description: '내용',
  })
  // =================================
  @IsNotEmpty()
  content: string;

  @ApiProperty({
    description: '첨부파일 list',
  })
  // =================================
  @IsArray()
  filePath: string[];
}

export class UserDriveUpdateReqDto extends UserDriveCreateReqDto {
  @ApiProperty({
    description: '수정할 user drive id',
  })
  // =================================
  @IsNotEmpty()
  id: number;

  @ApiProperty({
    description: '수정할 상태값 ex) 등록: REGISTER, 진행: PROGRESS, 완료: COMPLETE',
  })
  // =================================
  @IsNotEmpty()
  status: IUserDriveStatus;
}
