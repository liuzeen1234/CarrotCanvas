import { AssetKind } from '../assets/asset.entity';
export interface IoItem {
  itemKey: string; assetId: string; kind: AssetKind; name: string; note: string; hash: string; text?: string;
  sourceCanvasId?: string; sourceCanvasName?: string; sourceOutputId?: string; sourceOutputsVersion?: number; sourceAssetId?: string; sourceNodeId?: string; sourceRunId?: string; outputSlot?: string;
}
export interface IoSnapshot {
  id: string; version: number; createdAt: string; actorId: string; sourceOutputsVersion?: number; items: IoItem[];
}
export interface IoInputGroup {
  id: string; name: string; note: string; sourceType: 'file' | 'canvas'; sourceCanvasId?: string; sourceCanvasName?: string;
  /** 单项画布输出订阅；缺省表示跟踪来源画布的完整输出清单。 */
  sourceItemKey?: string;
  activeSnapshotId: string; snapshots: IoSnapshot[];
}
export interface CanvasIoState { schemaVersion: 1; inputs: IoInputGroup[]; removedInputs?: IoInputGroup[]; outputs: IoSnapshot[]; }
export const emptyCanvasIo = (): CanvasIoState => ({ schemaVersion: 1, inputs: [], outputs: [] });
export const activeInput = (group: IoInputGroup) => group.snapshots.find(s => s.id === group.activeSnapshotId)!;
export const currentOutput = (io: CanvasIoState) => io.outputs[io.outputs.length - 1];
