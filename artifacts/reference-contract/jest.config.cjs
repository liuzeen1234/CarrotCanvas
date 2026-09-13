module.exports = {
  rootDir: '../..',
  roots: ['<rootDir>/artifacts/reference-contract', '<rootDir>/backend/src'],
  testEnvironment: 'node',
  transform: { '^.+\\.tsx?$': ['<rootDir>/backend/node_modules/ts-jest', { tsconfig: '<rootDir>/backend/tsconfig.json' }] },
  moduleDirectories: ['node_modules', '<rootDir>/backend/node_modules'],
  setupFiles: ['<rootDir>/backend/test/jest-setup.ts'],
  testMatch: ['<rootDir>/artifacts/reference-contract/reference-storage.spec.ts'],
};
