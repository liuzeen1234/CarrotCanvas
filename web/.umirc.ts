import { defineConfig } from '@umijs/max';

export default defineConfig({
  antd: {},
  access: {},
  model: {},
  initialState: {},
  request: {},
  layout: {
    title: 'CarrotCanvas',
  },
  proxy: {
    '/api': {
      target: 'http://localhost:3100',
      changeOrigin: true,
    },
  },
});
