import { Outlet } from 'umi';
import { ConfigProvider, theme } from 'antd';

export default function RootLayout() {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#fa8c16',
        },
      }}
    >
      <Outlet />
    </ConfigProvider>
  );
}
