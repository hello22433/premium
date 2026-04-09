import { HttpStatus } from '@nestjs/common';

export interface AuthErrorDefinition {
  code: string;
  message: string;
  status: HttpStatus;
}

/**
 * 로그인/인증 관련 에러 코드 정의.
 *
 * 프론트엔드는 `errorCode`(영문 상수)로 로직을 분기하고,
 * `message`(한국어)는 사용자 표시용으로만 사용한다.
 * 기존 한국어 메시지는 하위호환을 위해 변경하지 않는다.
 */
export const AuthErrorCode = {
  USER_NOT_FOUND: {
    code: 'USER_NOT_FOUND',
    message: '해당 이메일의 유저가 존재하지 않습니다.',
    status: HttpStatus.BAD_REQUEST,
  },
  USER_NOT_APPROVED: {
    code: 'USER_NOT_APPROVED',
    message: '승인후 사용 가능합니다.',
    status: HttpStatus.BAD_REQUEST,
  },
  INVALID_PASSWORD: {
    code: 'INVALID_PASSWORD',
    message: 'USER_DO_NOT_MATCH_PASSWORD',
    status: HttpStatus.BAD_REQUEST,
  },
  IP_NOT_ALLOWED: {
    code: 'IP_NOT_ALLOWED',
    message: '허용된 IP가 아닙니다.',
    status: HttpStatus.BAD_REQUEST,
  },
  VERIFY_DATA_NOT_FOUND: {
    code: 'VERIFY_DATA_NOT_FOUND',
    message: '인증 데이터가 없습니다.',
    status: HttpStatus.BAD_REQUEST,
  },
  EXPIRED_VERIFY_CODE: {
    code: 'EXPIRED_VERIFY_CODE',
    message: '만료된 인증 코드입니다.',
    status: HttpStatus.BAD_REQUEST,
  },
  INVALID_VERIFY_CODE: {
    code: 'INVALID_VERIFY_CODE',
    message: '코드가 일치하지 않습니다.',
    status: HttpStatus.BAD_REQUEST,
  },
  ALREADY_VERIFIED: {
    code: 'ALREADY_VERIFIED',
    message: '이미 인증 완료된 코드입니다.',
    status: HttpStatus.BAD_REQUEST,
  },
  INVALID_VERIFY_REQUEST: {
    code: 'INVALID_VERIFY_REQUEST',
    message: '유효하지 않은 인증 요청입니다.',
    status: HttpStatus.BAD_REQUEST,
  },
  PHONE_NOT_REGISTERED: {
    code: 'PHONE_NOT_REGISTERED',
    message: '등록된 연락처가 없습니다. 관리자에게 문의해주세요.',
    status: HttpStatus.BAD_REQUEST,
  },
  SEND_FAILED: {
    code: 'SEND_FAILED',
    message: '인증코드 발송에 실패했습니다. 잠시 후 다시 시도해주세요.',
    status: HttpStatus.BAD_REQUEST,
  },
  TARGET_EMAIL_REQUIRED: {
    code: 'TARGET_EMAIL_REQUIRED',
    message: '담당자 이메일이 2개 이상일 때는 targetEmail이 필수입니다.',
    status: HttpStatus.BAD_REQUEST,
  },
  INVALID_TARGET_EMAIL: {
    code: 'INVALID_TARGET_EMAIL',
    message: '유효하지 않은 담당자 이메일입니다.',
    status: HttpStatus.BAD_REQUEST,
  },
} as const satisfies Record<string, AuthErrorDefinition>;

export type AuthErrorCodeKey = keyof typeof AuthErrorCode;
