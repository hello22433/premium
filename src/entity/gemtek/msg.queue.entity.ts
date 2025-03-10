import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('MSG_QUEUE')
@Index('MSG_QUEUE_IDX', ['stat', 'requestTime', 'msgType'])
export class GemteckMsgQueueEntity {
  @PrimaryGeneratedColumn({ name: 'MSEQ' })
  mseq: number;

  @Column({ name: 'MSG_TYPE', type: 'char', length: 1 })
  msgType: string;

  @Column({ name: 'DSTADDR', type: 'varchar', length: 64 })
  dstAddr: string;

  @Column({ name: 'CALLBACK', type: 'varchar', length: 64 })
  callback: string;

  @Column({ name: 'STAT', type: 'char', length: 1 })
  stat: string;

  @Column({ name: 'SUBJECT', type: 'varchar', length: 120 })
  subject: string;

  @Column({ name: 'TEXT', type: 'varchar', length: 4000, nullable: true })
  text: string | null;

  @Column({ name: 'TEXT_ENCODING', type: 'varchar', length: 2, nullable: true })
  textEncoding: string | null;

  @Column({ name: 'FILECNT', type: 'int' })
  fileCnt: number;

  @Column({ name: 'FILELOC1', type: 'varchar', length: 512, nullable: true })
  fileLoc1: string | null;

  @Column({ name: 'FILESIZE1', type: 'int', nullable: true })
  fileSize1: number | null;

  @Column({ name: 'FILELOC2', type: 'varchar', length: 512, nullable: true })
  fileLoc2: string | null;

  @Column({ name: 'FILESIZE2', type: 'int', nullable: true })
  fileSize2: number | null;

  @Column({ name: 'FILELOC3', type: 'varchar', length: 512, nullable: true })
  fileLoc3: string | null;

  @Column({ name: 'FILESIZE3', type: 'int', nullable: true })
  fileSize3: number | null;

  @Column({ name: 'FILELOC4', type: 'varchar', length: 512, nullable: true })
  fileLoc4: string | null;

  @Column({ name: 'FILESIZE4', type: 'int', nullable: true })
  fileSize4: number | null;

  @Column({ name: 'FILELOC5', type: 'varchar', length: 512, nullable: true })
  fileLoc5: string | null;

  @Column({ name: 'FILESIZE5', type: 'int', nullable: true })
  fileSize5: number | null;

  @Column({ name: 'FILECNT_CHECKUP', type: 'int' })
  fileCntCheckup: number;

  @Column({ name: 'INSERT_TIME', type: 'datetime' })
  insertTime: Date;

  @Column({ name: 'REQUEST_TIME', type: 'datetime' })
  requestTime: Date;

  @Column({ name: 'SEND_TIME', type: 'datetime', nullable: true })
  sendTime: Date | null;

  @Column({ name: 'REPORT_TIME', type: 'datetime', nullable: true })
  reportTime: Date | null;

  @Column({ name: 'TCPRECV_TIME', type: 'datetime', nullable: true })
  tcpRecvTime: Date | null;

  @Column({ name: 'SAVE_TIME', type: 'datetime', nullable: true })
  saveTime: Date | null;

  @Column({ name: 'TELECOM', type: 'varchar', length: 10, nullable: true })
  telecom: string | null;

  @Column({ name: 'RESULT', type: 'varchar', length: 4, nullable: true })
  result: string | null;

  @Column({ name: 'SERVER_ID', type: 'varchar', length: 16, nullable: true })
  serverId: string | null;

  @Column({ name: 'KAKAO_METHOD', type: 'char', length: 1, nullable: true })
  kakaoMethod: string | null;

  @Column({ name: 'SENDER_KEY', type: 'varchar', length: 40, nullable: true })
  senderKey: string | null;

  @Column({ name: 'TEMPLATE_CODE', type: 'varchar', length: 30, nullable: true })
  templateCode: string | null;

  @Column({ name: 'KAKAO_SIDE_INFO', type: 'varchar', length: 3000, nullable: true })
  kakaoSideInfo: string | null;

  @Column({ name: 'REPLACE_TEXT', type: 'varchar', length: 4000, nullable: true })
  replaceText: string | null;

  @Column({ name: 'FAILOVER', type: 'char', length: 1, nullable: true })
  failover: string | null;

  @Column({ name: 'KAKAO_RESULT', type: 'varchar', length: 4, nullable: true })
  kakaoResult: string | null;

  @Column({ name: 'SPAM_PROCESS', type: 'char', length: 1, nullable: true })
  spamProcess: string | null;

  @Column({ name: 'SENDER_CODE', type: 'varchar', length: 10, nullable: true })
  senderCode: string | null;

  @Column({ name: 'DPT_CODE', type: 'varchar', length: 10, nullable: true })
  dptCode: string | null;

  @Column({ name: 'NAT_CODE', type: 'varchar', length: 16, nullable: true })
  natCode: string | null;

  @Column({ name: 'OPT_ID', type: 'varchar', length: 20, nullable: true })
  optId: string | null;

  @Column({ name: 'OPT_CMP', type: 'varchar', length: 40, nullable: true })
  optCmp: string | null;

  @Column({ name: 'OPT_POST', type: 'varchar', length: 40, nullable: true })
  optPost: string | null;

  @Column({ name: 'OPT_NAME', type: 'varchar', length: 40, nullable: true })
  optName: string | null;

  @Column({ name: 'EXT_COL0', type: 'int', nullable: true })
  extCol0: number | null;

  @Column({ name: 'EXT_COL1', type: 'varchar', length: 64, nullable: true })
  extCol1: string | null;

  @Column({ name: 'EXT_COL2', type: 'varchar', length: 32, nullable: true })
  extCol2: string | null;

  @Column({ name: 'EXT_COL3', type: 'varchar', length: 32, nullable: true })
  extCol3: string | null;

  // @Column({ name: 'ENM_ETC_01', type: 'varchar', length: 2000, nullable: true })
  // enmEtc01: string | null;
  //
  // @Column({ name: 'ENM_ETC_02', type: 'varchar', length: 2000, nullable: true })
  // enmEtc02: string | null;
  //
  // @Column({ name: 'ENM_ETC_03', type: 'varchar', length: 2000, nullable: true })
  // enmEtc03: string | null;
  //
  // @Column({ name: 'ENM_ETC_04', type: 'varchar', length: 2000, nullable: true })
  // enmEtc04: string | null;
  //
  // @Column({ name: 'ENM_ETC_05', type: 'varchar', length: 2000, nullable: true })
  // enmEtc05: string | null;
}
