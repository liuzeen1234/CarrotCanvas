import { useEffect, useState } from 'react';
import { Card, Typography, Space, Tag, Button } from 'antd';
import { request, Link } from 'umi';

const { Title, Paragraph } = Typography;

export default function IndexPage() {
  const [health, setHealth] = useState<string>('...');

  useEffect(() => {
    request('/api/health')
      .then((res) => setHealth(res.status))
      .catch(() => setHealth('unreachable'));
  }, []);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%', padding: 32 }}>
      <Card>
        <Title level={3}>CarrotCanvas 🥕</Title>
        <Paragraph>
          本地 ComfyUI 生图 / 生视频工作台 · 无限画布节点编排
        </Paragraph>
        <div>
          后端健康状态: <Tag color={health === 'ok' ? 'success' : 'error'}>{health}</Tag>
        </div>
        <br />
        <Link to="/canvas">
          <Button type="primary">进入画布 →</Button>
        </Link>
        <Link to="/settings">
          <Button>设置</Button>
        </Link>
      </Card>
    </Space>
  );
}
