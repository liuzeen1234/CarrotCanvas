/**
 * CarrotCanvas 结果节点（C5）。
 * 输入句柄：image（接文生图生成节点）。
 * 自身不冗余存资产引用，C6 通过连线解析上游生成节点的 lastAssets（平台资产 URL）做大图预览。
 * C5 阶段仅渲染外壳 + 空态占位。
 */
import { useContext } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Button, Empty, Popconfirm, Tooltip } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { CanvasNodeDataContext } from '../context';
import { HANDLE_IMAGE_TARGET } from './types';

export default function ResultNode(props: NodeProps) {
  const { deleteNode } = useContext(CanvasNodeDataContext);
  return (
    <div className={`canvas-node canvas-node--result${props.selected ? ' selected' : ''}`}>
      <Handle
        type="target"
        position={Position.Left}
        id={HANDLE_IMAGE_TARGET}
        className="canvas-handle--image"
        title="生成结果输入"
      />
      <div className="canvas-node__header">
        <span className="canvas-node__type" style={{ background: '#722ed1' }}>
          结果
        </span>
        <span className="canvas-node__bind" style={{ color: '#999' }}>
          大图预览
        </span>
        <Popconfirm
          title="删除该节点？"
          description="将同时移除与它相连的连线，不可撤销。"
          okText="删除"
          okButtonProps={{ danger: true }}
          cancelText="取消"
          onConfirm={() => deleteNode(props.id)}
        >
          <Tooltip title="删除节点">
            <Button size="small" type="text" danger icon={<DeleteOutlined />} className="nodrag" />
          </Tooltip>
        </Popconfirm>
      </div>
      <div className="canvas-node__body canvas-node__result-body">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="等待上游生成结果"
        />
      </div>
    </div>
  );
}
