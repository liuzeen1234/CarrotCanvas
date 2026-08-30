import { useState } from 'react';
import { Layout, Menu, Typography } from 'antd';
import { ProfileOutlined, ApiOutlined } from '@ant-design/icons';
import WorkflowManager from '@/components/settings/WorkflowManager';

const { Sider, Content } = Layout;
const { Title } = Typography;

type SettingsTab = 'workflows' | 'comfyui';

export default function SettingsPage() {
  const [active, setActive] = useState<SettingsTab>('workflows');

  return (
    <Layout style={{ padding: 24, background: 'transparent' }}>
      <Title level={3} style={{ marginTop: 0 }}>
        设置
      </Title>
      <Layout style={{ background: '#fff', borderRadius: 8, overflow: 'hidden' }}>
        <Sider width={200} theme="light" style={{ borderRight: '1px solid #f0f0f0' }}>
          <Menu
            mode="inline"
            selectedKeys={[active]}
            style={{ height: '100%', borderRight: 0 }}
            onClick={({ key }) => setActive(key as SettingsTab)}
            items={[
              { key: 'workflows', icon: <ProfileOutlined />, label: '工作流管理' },
              { key: 'comfyui', icon: <ApiOutlined />, label: 'ComfyUI 连接' },
            ]}
          />
        </Sider>
        <Content style={{ padding: 24 }}>
          {active === 'workflows' ? (
            <WorkflowManager />
          ) : (
            <Typography.Paragraph type="secondary">
              ComfyUI 连接配置（地址、密钥）将在后续实现。
            </Typography.Paragraph>
          )}
        </Content>
      </Layout>
    </Layout>
  );
}
