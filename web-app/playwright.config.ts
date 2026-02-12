import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results/model-comparison',

  // One model at a time — WebGPU contexts compete for GPU memory
  fullyParallel: false,
  workers: 1,

  // Model loading + inference can be slow
  timeout: 10 * 60 * 1000, // 10 minutes per test

  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],

  use: {
    baseURL: 'http://localhost:5173',
    screenshot: 'on',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium-webgpu',
      use: {
        ...devices['Desktop Chrome'],
        // Use real GPU headless (Chrome 112+ "new headless" keeps GPU access).
        // Falls back gracefully if WebGPU isn't available — model tests skip.
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan',
            '--enable-gpu-rasterization',
            '--disable-gpu-sandbox',
            '--use-angle=metal', // macOS: use Metal backend for GPU access in headless
          ],
        },
      },
    },
  ],

  webServer: {
    command: 'npm run dev',
    port: 5173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
