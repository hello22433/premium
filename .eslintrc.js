module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: ['plugin:@typescript-eslint/recommended', 'plugin:prettier/recommended'],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js'],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    // PR1+ Wallet: legacy 컬럼 접근 단단한 동결. PR2~PR5에서 호출부 이관 완료 시 단계적 해제.
    // entity 자체 (entity/user.entity.ts, entity/user.company.entity.ts)는 정의 파일이므로 overrides로 제외.
    // 아래 6개 caller 파일도 PR1a 머지 시점에 빌드 통과 위해 overrides로 일시 허용. PR2~PR5에서 이관 완료 시 제거.
    'no-restricted-properties': [
      'error',
      {
        object: 'user',
        property: 'balance',
        message: 'DEPRECATED — wallet_account.deposit_balance 사용. WalletAccountResolverService로 settlement_code 단위 조회.',
      },
      {
        object: 'userCompany',
        property: 'balance',
        message: 'DEPRECATED — wallet_account.deposit_balance 사용.',
      },
      {
        object: 'userCompany',
        property: 'balanceManagementType',
        message: 'DEPRECATED — settlement_code로 통합. ACCOUNT/COMPANY 분기 폐지.',
      },
      {
        object: 'company',
        property: 'balance',
        message: 'DEPRECATED — wallet_account.deposit_balance 사용.',
      },
      {
        object: 'company',
        property: 'balanceManagementType',
        message: 'DEPRECATED — settlement_code로 통합.',
      },
      {
        object: 'user',
        property: 'settleCondition',
        message: 'DEPRECATED — wallet_account.settle_condition 사용. settlement_code 단위 정책.',
      },
      {
        object: 'user',
        property: 'settleMethod',
        message: 'DEPRECATED — wallet_account.settle_method 사용. settlement_code 단위 정책.',
      },
    ],
  },
  overrides: [
    {
      // entity 정의 파일은 deprecated 주석만 추가하고 규칙 대상에서 제외
      files: ['src/entity/user.entity.ts', 'src/entity/user.company.entity.ts'],
      rules: { 'no-restricted-properties': 'off' },
    },
    {
      // PR1a 머지 시점 legacy caller 6개. PR2~PR5에서 settlement_code 이관 완료 시 entry 제거.
      files: [
        'src/order/application/order.service.ts',
        'src/external_api/application/external.api.service.ts',
        'src/user_management/application/user.management.service.ts',
        'src/customer_service/application/customer.service.service.ts',
        'src/settle/application/settle.service.ts',
        'src/user_management/api/user.management.res.dto.ts',
      ],
      rules: { 'no-restricted-properties': 'off' },
    },
    {
      // 테스트 픽스처도 deprecated 컬럼을 셋업할 수 있으므로 제외
      files: ['**/*.spec.ts'],
      rules: { 'no-restricted-properties': 'off' },
    },
  ],
};
