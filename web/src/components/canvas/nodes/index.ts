/**
 * CarrotCanvas 画布节点统一出口（C5，新交互）。
 * 导出 nodeTypes（React Flow 注册）：生成节点 txt2img / 结果节点 result。
 * 节点添加改为画布空白右键分级菜单（§4.2.1），不再有顶栏工具栏；
 * 生成节点由菜单落点创建即绑定所选工作流。
 */
import { NodeTypes } from '@xyflow/react';
import Txt2ImgNode from './Txt2ImgNode';
import ResultNode from './ResultNode';
import { NODE_TYPE_RESULT, NODE_TYPE_TXT2IMG } from './types';
import './nodes.css';

/** React Flow 节点类型注册表 */
export const canvasNodeTypes: NodeTypes = {
  [NODE_TYPE_TXT2IMG]: Txt2ImgNode,
  [NODE_TYPE_RESULT]: ResultNode,
};
