import { Typography } from 'antd';
import WorkflowManager from '@/components/settings/WorkflowManager';

const { Title } = Typography;

export default function SettingsPage() {
  return (
    <div style={{ padding: 24 }}>
      <Title level={3} style={{ marginTop: 0 }}>
        设置
      </Title>
      <WorkflowManager />
    </div>
  );
}
