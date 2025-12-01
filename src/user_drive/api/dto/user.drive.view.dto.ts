import { ApiProperty } from '@nestjs/swagger';
import { IUserDriveStatus } from '../../interface/user.drive.status';

export class UserDriveViewDto {
  @ApiProperty({
    description: 'user drive id',
  })
  id: number;

  @ApiProperty({
    description: '수신일 ex) yyyy-mm-dd',
  })
  receiveAt: string | null;

  @ApiProperty({
    description: '발신자 소속 고객사명',
  })
  senderBusinessName: string;

  @ApiProperty({
    description: '수신인',
  })
  receiverPersonName: string;

  @ApiProperty({
    description: '발신인',
  })
  senderName: string;

  @ApiProperty({
    description: '제목',
  })
  title: string;

  @ApiProperty({
    description: '첨부파일 유무',
  })
  isFile: boolean;

  @ApiProperty({
    description: '상태',
    enum: IUserDriveStatus,
  })
  status: IUserDriveStatus;
}
