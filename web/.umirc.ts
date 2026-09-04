import { defineConfig } from '@umijs/max';

export default defineConfig({
  antd: {},
  access: {},
  model: {},
  initialState: {},
  request: {},
  // MFSU 的远程依赖脚本在当前 Windows 开发服务中会长时间挂起，
  // 外部设备只能拿到 HTML 而无法挂载 React，表现为白屏。
  mfsu: false,
  esbuildMinifyIIFE: true,
  layout: {
    title: 'CarrotCanvas',
  },
  routes: [
    { path: '/', redirect: '/welcome' },
    { path: '/welcome', component: './index', name: '首页', icon: 'HomeOutlined' },
    { path: '/canvas', component: './canvas/index', name: '画布', icon: 'DashboardOutlined' },
    { path: '/canvas/:id', component: './canvas/editor' },
    { path: '/capabilities', component: './capabilities', name: 'AI 能力', icon: 'AppstoreOutlined' },
    {
      path: '/comfyui-api',
      component: './settings/comfyui-api',
      name: 'ComfyUI API',
      icon: 'ApiOutlined',
    },
    {
      path: '/settings',
      component: './settings',
      name: '设置',
      icon: 'SettingOutlined',
    },
  ],
  proxy: {
    '/api': {
      target: 'http://localhost:3100',
      changeOrigin: true,
    },
  },
});
