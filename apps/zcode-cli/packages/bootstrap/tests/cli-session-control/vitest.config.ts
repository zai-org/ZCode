// 独立验证本 adapter；不加载根应用 setup，也不依赖 CLI 聚合构建。
export default {
  test: {
    environment: "node",
    setupFiles: [],
    include: [
      "tests/cli-session-control/**/*.test.ts",
      "src/cli-session-control/contract.test.ts",
      "tests/session-control/standalone-bootstrap.test.ts",
    ],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
};
