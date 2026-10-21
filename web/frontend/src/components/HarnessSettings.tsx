import { useEffect, useRef, useState } from 'react';
import {
  deletePiProvider,
  fetchHarnessModels,
  fetchHarnessSettings,
  fetchPiProviders,
  saveHarnessSettings,
  savePiProvider,
} from '../lib/api';
import type { HarnessModel, HarnessSettingsResponse, PiProviderSummary } from '../lib/api';
import SettingsSelect from './SettingsSelect';

const EMPTY_PROVIDER = {
  id: '',
  name: '',
  baseUrl: '',
  api: 'openai-completions',
  apiKey: '',
  models: '',
};

const API_LABELS: Record<string, string> = {
  'openai-completions': 'OpenAI Chat Completions 兼容',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Google Generative AI',
  'azure-openai-responses': 'Azure OpenAI Responses',
  'mistral-conversations': 'Mistral Conversations',
  'bedrock-converse-stream': 'AWS Bedrock Converse',
  'openai-codex-responses': 'OpenAI Codex Responses',
  'google-vertex': 'Google Vertex',
  'pi-messages': 'Pi Messages',
};

/**
 * Agent kernel settings.
 *
 * Easel has exactly one agent base: pi running in-process through its TypeScript
 * SDK. This panel therefore configures the pi model and its tool permission
 * boundary, not a runtime picker.
 */
export default function HarnessSettings({ onChange, onModelConfigured }: {
  onChange: (runtime: string) => void;
  onModelConfigured?: () => void;
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
  const [providers, setProviders] = useState<PiProviderSummary[]>([]);
  const [providerApis, setProviderApis] = useState<string[]>([]);
  const [providerModelsPath, setProviderModelsPath] = useState('');
  const [providerForm, setProviderForm] = useState({ ...EMPTY_PROVIDER });
  const [editingProvider, setEditingProvider] = useState('');
  const [providerLoading, setProviderLoading] = useState(true);
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerNote, setProviderNote] = useState('');

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
    }).catch((error) => {
      if (alive) setNote(`读取失败：${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      if (alive) setSettingsLoading(false);
    });
    return () => { alive = false; modelRequest.current += 1; };
  }, [onChange, refresh]);

  useEffect(() => {
    let alive = true;
    setProviderLoading(true);
    fetchPiProviders().then((value) => {
      if (!alive) return;
      setProviders(value.providers);
      setProviderApis(value.apis);
      setProviderModelsPath(value.modelsPath);
    }).catch((error) => {
      if (alive) setProviderNote(`读取 models.json 失败：${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      if (alive) setProviderLoading(false);
    });
    return () => { alive = false; };
  }, [refresh]);

  const pullModels = async () => {
    const sequence = ++modelRequest.current;
    setModelLoading(true);
    setModelNote('');
    try {
      const result = await fetchHarnessModels('pi');
      if (modelRequest.current !== sequence) return;
      setCatalogs(result.models);
      if (!result.models.length) {
        setModelNote('pi 还没有可用模型。请在设置页添加供应商、在终端运行 `pi` 完成 /login，或在 .env 配置 EASEL_DIRECT_API_*。');
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

  const resetProviderForm = () => {
    setEditingProvider('');
    setProviderForm({ ...EMPTY_PROVIDER });
    setProviderNote('');
  };

  const beginEditProvider = (provider: PiProviderSummary) => {
    setEditingProvider(provider.id);
    setProviderForm({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: provider.api,
      apiKey: '',
      models: provider.models.join('\n'),
    });
    setProviderNote('');
  };

  const saveProvider = async () => {
    const models = providerForm.models.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
    if (!providerForm.baseUrl.trim() || !models.length) {
      setProviderNote('请填写 Base URL 和至少一个模型 ID。');
      return;
    }
    setProviderBusy(true);
    setProviderNote('');
    try {
      const result = await savePiProvider({
        id: providerForm.id,
        name: providerForm.name,
        baseUrl: providerForm.baseUrl,
        api: providerForm.api,
        apiKey: providerForm.apiKey,
        models,
      });
      setProviders(result.providers);
      setProviderApis(result.apis);
      setProviderModelsPath(result.modelsPath);
      setCatalogs(result.models);
      const firstModel = result.provider?.models[0];
      if (!model && firstModel && result.provider) setModel(`${result.provider.id}/${firstModel}`);
      if (result.models.length) onModelConfigured?.();
      setEditingProvider('');
      setProviderForm({ ...EMPTY_PROVIDER });
      setProviderNote('已写入 pi 的 models.json，下个对话回合即可使用；再点「保存配置」可把它设为当前模型。');
    } catch (error) {
      setProviderNote(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setProviderBusy(false);
    }
  };

  const removeProvider = async (provider: PiProviderSummary) => {
    if (!window.confirm(`从 pi 的 models.json 删除供应商「${provider.name}」？`)) return;
    setProviderBusy(true);
    setProviderNote('');
    try {
      const result = await deletePiProvider(provider.id);
      setProviders(result.providers);
      setProviderApis(result.apis);
      setProviderModelsPath(result.modelsPath);
      setCatalogs(result.models);
      if (model.startsWith(`${provider.id}/`)) setModel('');
      if (editingProvider === provider.id) resetProviderForm();
      setProviderNote(`已从 models.json 删除供应商「${provider.id}」。`);
    } catch (error) {
      setProviderNote(`删除失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setProviderBusy(false);
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
            <code> EASEL_DIRECT_API_* </code>映射为 pi 的 <code>easel-direct</code> 供应商；
            其它 OpenAI / Anthropic / Google 兼容端点可在下方直接写入 pi 的 <code>models.json</code>。</p>
          {modelNote && <p className="desc" role="status">{modelNote}</p>}
        </div>
      </div>

      <div className="settings-field">
        <span className="settings-field-label">pi 供应商</span>
        <div className="settings-field-body">
          <p className="desc">直接维护 pi 原生的 <code>models.json</code>。保存后下个对话回合就能选用，
            不需要重启 Easel；API Key 只以脱敏值回显。</p>
          <div className="pi-provider-list">
            {providerLoading && <p className="desc">读取 models.json…</p>}
            {!providerLoading && !providers.length && (
              <p className="desc">models.json 里还没有自定义供应商，使用下方表单添加。</p>
            )}
            {providers.map((provider) => (
              <div className={`pi-provider-item${editingProvider === provider.id ? ' editing' : ''}`} key={provider.id}>
                <div className="pi-provider-main">
                  <div className="pi-provider-title">
                    <strong>{provider.name}</strong>
                    <code>{provider.id}</code>
                  </div>
                  <div className="desc">{provider.api} · {provider.baseUrl || '（未设置 Base URL）'}</div>
                  <div className="desc">
                    {provider.models.join('、') || '未配置模型'}
                    {provider.keyMasked ? ` · Key ${provider.keyMasked}` : ''}
                  </div>
                </div>
                <div className="pi-provider-actions">
                  {provider.managed ? (
                    <span className="desc">由 .env 管理</span>
                  ) : (
                    <>
                      <button type="button" className="btn btn-sm" disabled={providerBusy || settings?.locked}
                        onClick={() => beginEditProvider(provider)}>编辑</button>
                      <button type="button" className="btn btn-sm" disabled={providerBusy || settings?.locked}
                        onClick={() => void removeProvider(provider)}>删除</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="pi-provider-form">
            <div className="pi-provider-form-head">
              <strong>{editingProvider ? `编辑 ${editingProvider}` : '添加供应商'}</strong>
              <span className="desc">{providerModelsPath || 'pi models.json'}</span>
            </div>
            <div className="pi-form-row">
              <label htmlFor="pi-provider-id">供应商 ID</label>
              <input id="pi-provider-id" className="mock" value={providerForm.id}
                disabled={providerBusy || settings?.locked || Boolean(editingProvider)} maxLength={64}
                placeholder="例如 my-openai"
                onChange={(event) => setProviderForm((form) => ({ ...form, id: event.target.value }))} />
            </div>
            <div className="pi-form-row">
              <label htmlFor="pi-provider-name">显示名称</label>
              <input id="pi-provider-name" className="mock" value={providerForm.name}
                disabled={providerBusy || settings?.locked} maxLength={80} placeholder="可留空，默认使用供应商 ID"
                onChange={(event) => setProviderForm((form) => ({ ...form, name: event.target.value }))} />
            </div>
            <div className="pi-form-row">
              <label htmlFor="pi-provider-base">Base URL</label>
              <input id="pi-provider-base" className="mock" value={providerForm.baseUrl}
                disabled={providerBusy || settings?.locked} placeholder="https://api.example.com/v1"
                onChange={(event) => setProviderForm((form) => ({ ...form, baseUrl: event.target.value }))} />
            </div>
            <div className="pi-form-row">
              <label>API 类型</label>
              <SettingsSelect label="pi API 类型" value={providerForm.api} disabled={providerBusy || settings?.locked}
                options={(providerApis.length ? providerApis : [providerForm.api]).map((value) => ({
                  value,
                  label: API_LABELS[value] || value,
                }))}
                onChange={(api) => setProviderForm((form) => ({ ...form, api }))} />
            </div>
            <div className="pi-form-row">
              <label htmlFor="pi-provider-key">API Key</label>
              <input id="pi-provider-key" className="mock" type="password" value={providerForm.apiKey}
                disabled={providerBusy || settings?.locked}
                placeholder={editingProvider ? '留空表示保留已保存的 Key' : '可留空，改用供应商环境变量'}
                onChange={(event) => setProviderForm((form) => ({ ...form, apiKey: event.target.value }))} />
            </div>
            <div className="pi-form-row">
              <label htmlFor="pi-provider-models">模型 ID</label>
              <textarea id="pi-provider-models" className="mock pi-provider-models" rows={3}
                value={providerForm.models} disabled={providerBusy || settings?.locked}
                placeholder={'每行一个模型 ID，例如\ngpt-4.1\no3'}
                onChange={(event) => setProviderForm((form) => ({ ...form, models: event.target.value }))} />
            </div>
            <div className="pi-form-actions">
              <button type="button" className="btn btn-sm" disabled={providerBusy || settings?.locked}
                onClick={() => void saveProvider()}>
                {providerBusy ? '写入中…' : editingProvider ? '更新供应商' : '添加供应商'}
              </button>
              {(editingProvider || providerForm.id || providerForm.baseUrl || providerForm.models) && (
                <button type="button" className="btn btn-sm" disabled={providerBusy} onClick={resetProviderForm}>清空</button>
              )}
            </div>
            <p className="desc">API Key 会按 pi 的原生格式明文写入 <code>models.json</code>；也可以只填
              <code> $ENV_NAME </code> 让 pi 从环境变量读取。本地无鉴权端点可填任意占位 Key（如
              <code> ollama </code>），否则 pi 可能不会把模型列为可用。若同名供应商已在 pi 中登录，pi 会优先使用
              <code> auth.json </code> 里的凭据。</p>
            {providerNote && (
              <p className={`desc pi-provider-note${providerNote.includes('失败') ? ' err' : ''}`} role="status">
                {providerNote}
              </p>
            )}
          </div>
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
