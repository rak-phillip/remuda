module.exports = {
  testEnvironment: 'node',
  roots:           ['<rootDir>/pkg'],
  testMatch:       ['**/__tests__/**/*.test.ts'],
  // The whole @octokit tree is pure ESM ("type": "module", no CJS entry), so its
  // .js has to be transformed too -- and node_modules has to stop being ignored
  // for exactly those packages. Without this, importing utils/github.ts in a
  // test fails on the bare `export` in @octokit/rest's dist-src.
  //
  // content-type is listed because @octokit/request carries its own ESM copy at
  // node_modules/@octokit/request/node_modules/content-type. The hoisted
  // top-level content-type is CommonJS, so checking that one says it is fine.
  transformIgnorePatterns: [
    '/node_modules/(?!(@octokit|before-after-hook|universal-user-agent|json-with-bigint|content-type)/)',
  ],
  transform:       {
    '^.+\\.(ts|js)$': ['babel-jest', {
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
