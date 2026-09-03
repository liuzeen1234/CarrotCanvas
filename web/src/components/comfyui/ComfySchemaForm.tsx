/**
 * CarrotCanvas 共享 schema 动态表单组件（C4 抽取）。
 * 受控组件：输入 schema + 表单值 + onChange，渲染主区（暴露字段）与高级参数折叠区。
 * 设置页运行面板（ComfyRunModal）与画布生成节点（C5/C6）共用。
 */
import React from 'react';
import { Alert, Button, Collapse, Col, Divider, Input, InputNumber, Progress, Row, Select, Switch, Upload, message } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import {
  ExposureConfig,
  SchemaAnalysis,
  SchemaField,
  SchemaNodeGroup,
  fileKey,
  splitByExposure,
} from './types';

export interface ComfySchemaFormProps {
  schema: SchemaAnalysis | null;
  schemaLoading?: boolean;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
  exposure?: ExposureConfig | null;
  /** 提供时 upload 字段显示“上传新图”按钮；未提供则仅可从已有图选择 */
  onUploadImage?: (field: SchemaField, file: File) => Promise<string>;
  uploading?: boolean;
  /** 表单滚动区最大高度（仅 scroll 为 true 时生效） */
  maxHeight?: string | number;
  /**
   * 是否内部滚动。默认 true（设置页弹窗：限高 + overflow auto）。
   * 画布节点须传 false：节点按内容自然撑高、不出现内部滚动条，
   * 否则与画布缩放/平移滚动冲突。
   */
  scroll?: boolean;
  /**
   * 单列布局。默认 false（设置页弹窗：两列 Col span=12）。
   * 画布节点须传 true：每个控件独占一行、宽度 100%，窄卡片内不遮挡文字/选项。
   */
  singleColumn?: boolean;
}

/** schema 字段 → antd 控件（受控，值来自 props.values，key=`${nodeId}::${param}`） */
export function ComfySchemaForm({
  schema,
  schemaLoading,
  values,
  onChange,
  disabled = false,
  exposure = null,
  onUploadImage,
  uploading = false,
  maxHeight = '58vh',
  scroll = true,
  singleColumn = false,
}: ComfySchemaFormProps) {
  if (schemaLoading) {
    return (
      <div style={{ textAlign: 'center', padding: 32 }}>
        <Progress percent={100} size="small" status="active" />
        <div style={{ color: '#888', marginTop: 8 }}>正在分析可编辑参数…</div>
      </div>
    );
  }
  if (!schema || !schema.ok) {
    return (
      <Alert
        type="warning"
        showIcon
        message="无法生成自动表单"
        description="该工作流未能解析出可编辑参数，请切换到 JSON 模式直接编辑模板。"
      />
    );
  }

  const { primary, advanced } = splitByExposure(schema, exposure);
  const advancedCount = advanced.reduce((n, g) => n + g.fields.length, 0);

  return (
    <div style={scroll ? { maxHeight, overflow: 'auto', paddingRight: 8 } : { overflow: 'visible' }}>
      {primary.length > 0 ? (
        <RunGroups groups={primary} values={values} onChange={onChange} disabled={disabled} onUploadImage={onUploadImage} uploading={uploading} singleColumn={singleColumn} />
      ) : (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="该工作流未配置暴露字段，所有参数已收进下方高级参数区。"
        />
      )}
      {advancedCount > 0 && (
        <Collapse
          ghost
          items={[
            {
              key: 'advanced',
              label: `高级参数（${advancedCount} 项）`,
              children: (
                <RunGroups groups={advanced} values={values} onChange={onChange} disabled={disabled} onUploadImage={onUploadImage} uploading={uploading} singleColumn={singleColumn} />
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

interface RunGroupsProps {
  groups: SchemaNodeGroup[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
  onUploadImage?: (field: SchemaField, file: File) => Promise<string>;
  uploading?: boolean;
  singleColumn?: boolean;
}

/** 渲染一组节点分组的表单控件 */
function RunGroups({ groups, values, onChange, disabled, onUploadImage, uploading, singleColumn }: RunGroupsProps) {
  return (
    <>
      {groups.map((g) => (
        <div key={g.nodeId} style={{ marginBottom: 12 }}>
          <Divider orientation="left" style={{ margin: '8px 0' }}>
            <span style={{ fontSize: 13 }}>
              {g.nodeTitle}
              <span style={{ color: '#999', marginLeft: 8, fontSize: 12 }}>
                {g.classType} · {g.nodeId}
              </span>
            </span>
          </Divider>
          <Row gutter={singleColumn ? 0 : 16}>
            {g.fields.map((f) =>
              f.control === 'hidden' ? null : (
                <Col span={singleColumn ? 24 : 12} key={`${f.nodeId}::${f.param}`} style={{ marginBottom: 4 }}>
                  <div style={{ marginBottom: 2, fontSize: 12, color: '#555' }}>{f.label}</div>
                  <FieldControl
                    field={f}
                    value={values[fileKey(f)]}
                    onChange={(v) => onChange(fileKey(f), v)}
                    disabled={disabled}
                    onUploadImage={onUploadImage}
                    uploading={uploading}
                  />
                </Col>
              ),
            )}
          </Row>
        </div>
      ))}
    </>
  );
}

interface FieldControlProps {
  field: SchemaField;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  onUploadImage?: (field: SchemaField, file: File) => Promise<string>;
  uploading?: boolean;
}

function FieldControl({ field: f, value, onChange, disabled, onUploadImage, uploading }: FieldControlProps) {
  switch (f.control) {
    case 'input_number':
      return (
        <InputNumber
          style={{ width: '100%' }}
          value={value as number}
          min={f.min}
          max={f.max}
          step={f.step}
          disabled={disabled}
          onChange={(v) => onChange(v ?? undefined)}
        />
      );
    case 'textarea':
      return (
        <Input.TextArea
          autoSize={{ minRows: 3 }}
          style={{ width: '100%' }}
          value={String(value ?? '')}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'input':
      return (
        <Input
          style={{ width: '100%' }}
          value={String(value ?? '')}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'select':
      return (
        <Select
          style={{ width: '100%' }}
          value={(value as string | number) ?? undefined}
          showSearch
          disabled={disabled}
          options={(f.options ?? []).map((o) => ({ value: o, label: String(o) }))}
          onChange={(v) => onChange(v)}
        />
      );
    case 'switch':
      return <Switch checked={Boolean(value)} disabled={disabled} onChange={(v) => onChange(v)} />;
    case 'upload':
      return (
        <UploadField
          field={f}
          value={value}
          onChange={onChange}
          disabled={disabled}
          onUploadImage={onUploadImage}
          uploading={uploading}
        />
      );
    default:
      return null;
  }
}

interface UploadFieldProps {
  field: SchemaField;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  onUploadImage?: (field: SchemaField, file: File) => Promise<string>;
  uploading?: boolean;
}

/** upload 控件：从已有图片选择 + 上传新图片到 ComfyUI input 目录 */
function UploadField({ field: f, value, onChange, disabled, onUploadImage, uploading }: UploadFieldProps) {
  return (
    <div style={{ display: 'flex', gap: 8, width: '100%' }}>
      <Select
        style={{ flex: 1, minWidth: 0 }}
        value={(value as string | number) ?? undefined}
        showSearch
        disabled={disabled}
        placeholder="选择已有图片"
        options={(f.options ?? []).map((o) => ({ value: o, label: String(o) }))}
        onChange={(v) => onChange(v)}
      />
      {onUploadImage && (
        <Upload
          accept="image/*"
          showUploadList={false}
          disabled={disabled}
          customRequest={async ({ file, onSuccess, onError }) => {
            try {
              const name = await onUploadImage(f, file as File);
              message.success(`已上传 ${name}`);
              onSuccess?.({});
            } catch (e: any) {
              message.error(`上传失败：${e?.response?.data?.message || '未知错误'}`);
              onError?.(e as Error);
            }
          }}
        >
          <Button icon={<UploadOutlined />} loading={uploading} disabled={disabled} />
        </Upload>
      )}
    </div>
  );
}
