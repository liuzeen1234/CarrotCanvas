/**
 * CarrotCanvas 共享 schema 动态表单组件（C4 抽取）。
 * 受控组件：输入 schema + 表单值 + onChange，渲染主区（暴露字段）与高级参数折叠区。
 * 设置页运行面板（ComfyRunModal）与画布生成节点（C5/C6）共用。
 */
import React from 'react';
import { Alert, Button, Collapse, Col, Divider, Image, Input, InputNumber, Progress, Row, Select, Switch, Upload, message } from 'antd';
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
  /** 提交校验失败的字段 key；画布节点用红框标记 */
  invalidKeys?: ReadonlySet<string>;
  /** 画布节点可为特定字段渲染带类型的输入端点。 */
  renderInputConnector?: (field: SchemaField) => React.ReactNode;
  /** 画布连线实际提供的图片；存在时优先于卡片自身保存的默认图片展示。 */
  getConnectedImage?: (field: SchemaField) => { url: string; label?: string } | null;
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
  invalidKeys,
  renderInputConnector,
  getConnectedImage,
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
        <RunGroups groups={primary} values={values} onChange={onChange} disabled={disabled} onUploadImage={onUploadImage} uploading={uploading} singleColumn={singleColumn} invalidKeys={invalidKeys} renderInputConnector={renderInputConnector} getConnectedImage={getConnectedImage} />
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
                <RunGroups groups={advanced} values={values} onChange={onChange} disabled={disabled} onUploadImage={onUploadImage} uploading={uploading} singleColumn={singleColumn} invalidKeys={invalidKeys} renderInputConnector={renderInputConnector} getConnectedImage={getConnectedImage} />
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
  invalidKeys?: ReadonlySet<string>;
  renderInputConnector?: (field: SchemaField) => React.ReactNode;
  getConnectedImage?: (field: SchemaField) => { url: string; label?: string } | null;
}

/** 渲染一组节点分组的表单控件 */
function RunGroups({ groups, values, onChange, disabled, onUploadImage, uploading, singleColumn, invalidKeys, renderInputConnector, getConnectedImage }: RunGroupsProps) {
  return (
    <>
      {groups.map((g) => (
        <div key={g.nodeId} style={{ marginBottom: 12 }}>
          <Divider orientation="left" style={{ margin: '8px 0' }}>
            <span style={{ fontSize: 13, cursor: 'help' }} title={`${g.classType} · ${g.nodeId}`}>
              {g.nodeTitle}
            </span>
          </Divider>
          <Row gutter={singleColumn ? 0 : 16}>
            {g.fields.map((f) =>
              f.control === 'hidden' ? null : (
                <Col span={singleColumn ? 24 : 12} key={`${f.nodeId}::${f.param}`} style={{ marginBottom: 4, position: 'relative' }}>
                  {renderInputConnector?.(f)}
                  <div style={{ marginBottom: 2, fontSize: 12, color: invalidKeys?.has(fileKey(f)) ? '#ff4d4f' : '#555' }}>
                    {f.label}{f.required ? ' *' : ''}
                  </div>
                  <div className={invalidKeys?.has(fileKey(f)) ? 'comfy-field-invalid' : undefined}>
                  <FieldControl
                    field={f}
                    value={values[fileKey(f)]}
                    onChange={(v) => onChange(fileKey(f), v)}
                    disabled={disabled}
                    onUploadImage={onUploadImage}
                    uploading={uploading}
                    connectedImage={f.control === 'upload' ? getConnectedImage?.(f) ?? null : null}
                  />
                  </div>
                  {f.description ? <div style={{ marginTop: 3, color: '#8c8c8c', fontSize: 11, lineHeight: 1.4 }}>{f.description}</div> : null}
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
  connectedImage?: { url: string; label?: string } | null;
}

function FieldControl({ field: f, value, onChange, disabled, onUploadImage, uploading, connectedImage }: FieldControlProps) {
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
          connectedImage={connectedImage}
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
  connectedImage?: { url: string; label?: string } | null;
}

/** ComfyUI input 图片代理地址。图片列表里的值可能包含子目录，需拆成 filename/subfolder。 */
function inputImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim().replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  const filename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const subfolder = slash >= 0 ? normalized.slice(0, slash) : '';
  if (!filename) return null;
  const query = new URLSearchParams({ filename, type: 'input' });
  if (subfolder) query.set('subfolder', subfolder);
  return `/api/comfyui/view?${query.toString()}`;
}

/** upload 控件：当前图片预览 + 从已有图片选择 + 上传新图片到 ComfyUI input 目录 */
function UploadField({ field: f, value, onChange, disabled, onUploadImage, uploading, connectedImage }: UploadFieldProps) {
  const previewUrl = connectedImage?.url || inputImageUrl(value);
  return (
    <div style={{ width: '100%' }}>
      {previewUrl ? (
        <div
          style={{
            width: '100%',
            marginBottom: 8,
            padding: 4,
            border: '1px solid rgba(5, 5, 5, 0.1)',
            borderRadius: 6,
            background: '#fafafa',
            boxSizing: 'border-box',
            textAlign: 'center',
          }}
        >
          <Image
            src={previewUrl}
            alt={connectedImage?.label || String(value)}
            width="100%"
            style={{ width: '100%', maxHeight: 180, objectFit: 'contain', borderRadius: 4, display: 'block' }}
            fallback="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='160' viewBox='0 0 320 160'%3E%3Crect width='320' height='160' fill='%23f5f5f5'/%3E%3Ctext x='160' y='84' text-anchor='middle' font-family='sans-serif' font-size='14' fill='%23999'%3E%E5%9B%BE%E7%89%87%E6%97%A0%E6%B3%95%E9%A2%84%E8%A7%88%3C/text%3E%3C/svg%3E"
          />
        </div>
      ) : null}
      {connectedImage ? (
        <div style={{ color: '#52c41a', fontSize: 12, marginBottom: 4 }}>
          来自连线{connectedImage.label ? ` · ${connectedImage.label}` : ''}
        </div>
      ) : null}
      {!connectedImage ? (
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
      ) : null}
    </div>
  );
}
