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
  routes: [
    { path: '/', redirect: '/welcome' },
    { path: '/welcome', component: './index', name: '首页', icon: 'HomeOutlined' },
    { path: '/canvas', component: './canvas', name: '画布', icon: 'DashboardOutlined' },
    {
      path: '/settings',
      component: './settings',
      name: '设置',
      icon: 'SettingOutlined',
      routes: [
        {
          path: '/settings/comfyui-api',
          component: './settings/comfyui-api',
          name: 'ComfyUI API 管理',
        },
      ],
    },
  ],
  proxy: {
    '/api': {
      target: 'http://localhost:3100',
      changeOrigin: true,
    },
  },
});
