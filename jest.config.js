module.exports = {
  testEnvironment: 'node',
  roots:           ['<rootDir>/pkg'],
  testMatch:       ['**/__tests__/**/*.test.ts'],
  transform:       {
    '^.+\\.ts$': ['babel-jest', {
      // The root babel config delegates to @rancher/shell, which adds Vue-build
      // plugins that aren't installed here and aren't needed to transform plain TS.
      babelrc:    false,
      configFile: false,
      presets:    [
        ['@babel/preset-env', { targets: { node: 'current' } }],
        '@babel/preset-typescript',
      ],
    }],
  },
};
