import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // 确定性：测试不并行共享状态文件；单文件内顺序执行
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
