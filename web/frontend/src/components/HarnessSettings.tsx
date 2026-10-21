import { useEffect, useRef, useState } from 'react';
import { fetchHarnessModels, fetchHarnessSettings, saveHarnessSettings } from '../lib/api';
import type { HarnessModel, HarnessSettingsResponse } from '../lib/api';
import SettingsSelect from './SettingsSelect';

/**
 * Agent kernel settings.
 *
 * Easel has exactly one agent base: pi running in-process through its TypeScript
 * SDK. This panel therefore configures the pi model and its tool permission
 * boundary, not a runtime picker.
 */
export default function HarnessSettings({ onChange, onSelect }: {
  onChange: (runtime: string) => void;
  onSelect: (runtime: string) => void;
}) {
  const [settings, setSettings] = useState<HarnessSettingsResponse | null>(null);
  const [model, setModel] = useState('');
  const [sandbox, setSandbox] = useState('workspace-write');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [catalogs, setCatalogs] = useState<HarnessModel[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelNote, setModelNote] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const modelRequest = useRef(0);

  useEffect(() => {
    let alive = true;
    setSettingsLoading(true);
    setNote('');
    fetchHarnessSettings().then((value) => {
      if (!alive) return;
      setSettings(value);
      setModel(value.models.pi || '');
      setSandbox(value.sandbox || 'workspace-write');
      onChange('pi');
      onSelect('pi');
    }).catch((error) => {
      if (alive) setNote(`读取失败：${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      if (alive) setSettingsLoading(false);
    });
    return () => { alive = false; modelRequest.current += 1; };
  }, [onChange, onSelect, refresh]);

  const pullModels = async () => {
    const sequence = ++modelRequest.current;
    setModelLoading(true);
    setModelNote('');
    try {
      const result = await fetchHarnessModels('pi');
      if (modelRequest.current !== sequence) return;
      setCatalogs(result.models);
      if (!result.models.length) {
        setModelNote('pi 还没有可用模型。请先在终端运行 `pi` 完成 /login，或在 .env 配置 EASEL_DIRECT_API_*。');
      }
    } catch (error) {
      if (modelRequest.current === sequence) {
        setModelNote(`读取失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (modelRequest.current === sequence) setModelLoading(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setNote('');
    try {
      const value = await saveHarnessSettings('pi', model, sandbox);
      setSettings(value);
      onChange('pi');
      setNote('已保存。pi 的会话历史保持连续，不会迁移到其它底座。');
    } catch (error) {
      setNote(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="st-panel active harness-settings" aria-label="Agent 底座设置">
      <div className="panel-top">
        <strong>Agent 底座</strong>
        <span className="desc">pi TypeScript SDK · 唯一执行引擎</span>
        <span className="spacer" />
        <button className="btn btn-sm" disabled={!settings || settingsLoading || busy || settings?.locked}
          onClick={() => void save()}>{busy ? '保存中…' : '保存配置'}</button>
        <button className="btn btn-sm" disabled={settingsLoading || busy}
          onClick={() => setRefresh((previous) => previous + 1)}>{settingsLoading ? '读取中…' : '重新读取'}</button>
      </div>

      <div className="settings-field">
        <span className="settings-field-label">执行引擎</span>
        <div className="settings-field-body">
          <div className="settings-engine-control">
            <SettingsSelect label="执行引擎" value="pi" disabled
              options={[{ value: 'pi', label: 'Pi（TypeScript SDK）' }]} onChange={() => {}} />
            <span className="settings-help">
              <button type="button" className="settings-help-trigger" aria-label="pi 底座说明"
                aria-describedby="pi-kernel-help">ⓘ</button>
              <span id="pi-kernel-help" className="settings-help-tooltip" role="tooltip">
                Easel 只保留 pi 一个 Agent 内核。对话、工具调用、技能执行、ask_user 问答题和权限确认
                都运行在同一个 pi SDK 会话中，没有其它 Agent 内核或回退路径。
              </span>
            </span>
          </div>
          <p className="desc">pi 在 Node 后端进程内运行，通过 SDK 绑定 Easel 的问答题和权限扩展。</p>
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-field-label" htmlFor="harness-model">模型</label>
        <div className="settings-field-body">
          <div className="settings-native-models">
            <SettingsSelect label="pi 模型" value={model} disabled={busy || settings?.locked}
              options={[
                { value: '', label: '使用 pi 默认模型' },
                ...catalogs.map((item) => ({ value: item.id, label: `${item.label}${item.default ? '（默认）' : ''}` })),
                ...(model && !catalogs.some((item) => item.id === model)
                  ? [{ value: model, label: `${model}（当前 / 自定义）` }] : []),
              ]} onChange={setModel} />
            <button className="btn btn-sm" disabled={modelLoading || busy}
              onClick={() => void pullModels()}>{modelLoading ? '读取中…' : '读取模型'}</button>
          </div>
          <input id="harness-model" className="mock" value={model} disabled={busy || settings?.locked} maxLength={240}
            onChange={(event) => setModel(event.target.value)}
            placeholder="provider/model；留空使用 pi 默认模型" />
          <p className="desc">模型来自 pi 的登录状态与 models.json。Easel 会把 .env 的
            <code> EASEL_DIRECT_API_* </code>映射为 pi 的 <code>easel-direct</code> 供应商。</p>
          {modelNote && <p className="desc" role="status">{modelNote}</p>}
        </div>
      </div>

      <div className="settings-field">
        <span className="settings-field-label">工具权限</span>
        <div className="settings-field-body">
          <SettingsSelect label="pi 工具权限" value={sandbox} disabled={busy || settings?.locked}
            options={[
              { value: 'workspace-write', label: '项目工作区写入' },
              { value: 'read-only', label: '只读' },
            ]}
            onChange={setSandbox} />
          <p className="desc">权限由 pi 的 <code>tool_call</code> 扩展在每次工具执行前判定。
            工作区写入允许常规读写；工作区外写入、危险命令和其它工具会弹出确认卡片。只读模式拒绝所有修改。</p>
        </div>
      </div>

      <p className="desc"><code>{settings?.agents?.[0]?.install_hint}</code></p>
      {settings?.locked && <p className="desc">启动环境已固定配置，请修改启动环境后重启。</p>}
      {note && <div className={`save-note${note.includes('失败') ? ' err' : ''}`} role="status">{note}</div>}
    </section>
  );
}
