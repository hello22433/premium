import { ApiProperty } from '@nestjs/swagger';
import { IUserDriveStatus } from '../../interface/user.drive.status';

export class UserDriveDetailDto {
  @ApiProperty({
    description: 'drive id',
  })
  id: number;

  @ApiProperty({
    description: '등록일 ex) yyyy-MM-ddTHH:mm:ss',
  })
  sendAt: string;

  @ApiProperty({
    description: '발신자 id',
  })
  senderId: number;

  @ApiProperty({
    description: '수신자 id',
  })
  receiverId: number;

  @ApiProperty({
    description: '발신자 고객사명',
  })
  senderBusinessName: string;

  @ApiProperty({
    description: '수신인',
  })
  receiverPersonName: string;

  @ApiProperty({
    description: '수신인 이메일',
  })
  receiverEmail: string;

  @ApiProperty({
    description: '수신인 전화번호',
  })
  receiverPhone: string;

  @ApiProperty({
    description: '제목',
  })
  title: string;

  @ApiProperty({
    description: '내용',
  })
  content: string;

  @ApiProperty({
    description: '상태 ex) 등록: REGISTER, 진행: PROGRESS, 완료: COMPLETE',
  })
  status: IUserDriveStatus;

  @ApiProperty({
    description: '파일 url list',
  })
  filePathList: string[];
}
