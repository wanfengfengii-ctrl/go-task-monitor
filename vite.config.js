import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api': process.env.GO_TASK_MONITOR_API_URL || 'http://127.0.0.1:4174',
    },
  },
});
