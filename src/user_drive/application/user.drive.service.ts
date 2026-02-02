import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UserDriveEntity } from '../../entity/user.drive.entity';
import { Repository } from 'typeorm';
import {
  UserDriveCreateReqDto,
  UserDriveGetDetailReqParamDto,
  UserDriveGetListReqDto,
  UserDriveReplyReqDto,
  UserDriveUpdateReqDto,
} from '../api/user.drive.req.dto';
import { UserDriveViewDto } from '../api/dto/user.drive.view.dto';
import { UserDriveGetDetailResDto, UserDriveGetListResDto } from '../api/user.drive.res.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { format } from 'date-fns';
import { DateFormatStr } from '../../common/domain/date.format.str';
import { UserEntity } from '../../entity/user.entity';
import { IUserDriveStatus } from '../interface/user.drive.status';

@Injectable()
export class UserDriveService {
  constructor(
    @InjectRepository(UserDriveEntity)
    private userDriveRepository: Repository<UserDriveEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) {}

  async getList(user: ILoginUserInfo, getQuery: UserDriveGetListReqDto): Promise<UserDriveGetListResDto> {
    const { take, page } = getQuery;

    let queryBuilder = this.userDriveRepository
      .createQueryBuilder('drive')
      .innerJoinAndSelect('drive.sender', 'sender')
      .innerJoinAndSelect('drive.receiver', 'receiver');

    if (user.authority === 'CORPORATE_ADMIN') {
      // 고객사에게는 DRAFT 상태 문서 미노출
      queryBuilder
        .where('drive.receiverId = :receiverId', { receiverId: user.id })
        .andWhere('drive.status != :draftStatus', { draftStatus: IUserDriveStatus.DRAFT });
    }

    queryBuilder.orderBy('drive.id', 'DESC');

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.skip(skip).take(take);
    const [driveList, totalCount] = await queryBuilder.getManyAndCount();

    const totalPage = Math.ceil(totalCount / take);

    const resultList: UserDriveViewDto[] = driveList.map((drive) => {
      const isFile = !!drive.filePath;
      return {
        id: drive.id,
        receiveAt: drive.receiveAt ? format(drive.receiveAt, DateFormatStr) : null,
        senderBusinessName: drive.sender.company?.businessName ?? '',
        receiverPersonName: drive.receiver.personName,
        senderName: drive.sender.personName,
        title: drive.title,
        status: drive.status,
        isFile: isFile,
      };
    });

    return { list: resultList, totalCount, totalPage, currentPage: page };
  }

  async getDetail(user: ILoginUserInfo, getParam: UserDriveGetDetailReqParamDto): Promise<UserDriveGetDetailResDto> {
    const { id } = getParam;
    const isCorporateAdmin = user.authority === 'CORPORATE_ADMIN';

    const whereCondition = isCorporateAdmin ? { id, receiverId: user.id } : { id };

    const userDrive = await this.userDriveRepository.findOne({
      where: whereCondition,
      relations: ['sender', 'receiver'],
    });

    if (!userDrive) {
      throw new BadRequestException('문서가 존재하지 않습니다.');
    }

    // 고객사에게는 DRAFT 상태 문서 미노출
    if (isCorporateAdmin && userDrive.status === IUserDriveStatus.DRAFT) {
      throw new BadRequestException('문서가 존재하지 않습니다.');
    }

    // 고객사가 조회 시 수신 시각 업데이트
    if (isCorporateAdmin) {
      userDrive.receiveAt = new Date();
      await this.userDriveRepository.save(userDrive);
    }

    return {
      id: userDrive.id,
      sendAt: format(userDrive.sendAt, DateFormatStr),
      senderId: userDrive.senderId,
      receiverId: userDrive.receiverId,
      senderBusinessName: userDrive.sender.company?.businessName ?? '',
      receiverPersonName: userDrive.receiver.personName,
      receiverEmail: userDrive.receiver.email,
      receiverPhone: userDrive.receiver.personPhoneNumber,
      title: userDrive.title,
      content: userDrive.content,
      status: userDrive.status,
      filePathList: userDrive.filePath ? userDrive.filePath.split(',') : [],
      replyContent: userDrive.replyContent,
    };
  }

  async create(user: ILoginUserInfo, getBody: UserDriveCreateReqDto) {
    const { title, content, receiverId, filePath, status } = getBody;

    if (user.authority === 'CORPORATE_ADMIN') {
      throw new BadRequestException('관리자만 접근 가능합니다.');
    }

    const receiver = await this.userRepository.findOne({
      where: {
        id: receiverId,
      },
    });

    if (!receiver) {
      throw new BadRequestException('고객사가 존재 하지 않습니다.');
    }

    await this.userDriveRepository.insert({
      senderId: user.id,
      receiverId: receiver.id,
      title,
      content,
      sendAt: new Date(),
      status: status ?? IUserDriveStatus.REGISTER,
      filePath: filePath.length === 0 ? null : filePath.join(','),
    });

    return;
  }

  async update(user: ILoginUserInfo, getBody: UserDriveUpdateReqDto) {
    const { id, receiverId, title, content, filePath, status } = getBody;

    if (user.authority === 'CORPORATE_ADMIN') {
      throw new BadRequestException('관리자만 접근 가능합니다.');
    }

    const userDrive = await this.userDriveRepository.findOne({
      where: {
        id,
      },
    });

    if (!userDrive) {
      throw new BadRequestException('문서가 존재하지 않습니다.');
    }

    const receiver = await this.userRepository.findOne({
      where: {
        id: receiverId,
      },
    });

    if (!receiver) {
      throw new BadRequestException('고객사가 존재 하지 않습니다.');
    }

    userDrive.title = title;
    userDrive.content = content;
    userDrive.receiverId = receiverId;
    userDrive.status = status;
    userDrive.filePath = filePath.length === 0 ? null : filePath.join(',');
    await this.userDriveRepository.save(userDrive);

    return;
  }

  async reply(user: ILoginUserInfo, getBody: UserDriveReplyReqDto) {
    const { id, replyContent } = getBody;

    const userDrive = await this.userDriveRepository.findOne({
      where: {
        id,
      },
    });

    if (!userDrive) {
      throw new BadRequestException('문서가 존재하지 않습니다.');
    }

    userDrive.replyContent = replyContent;

    await this.userDriveRepository.save(userDrive);
    return;
  }
}
