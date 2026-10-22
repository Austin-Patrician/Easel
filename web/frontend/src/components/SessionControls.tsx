import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchHarnessModels, fetchHarnessSettings } from '../lib/api';
import type { HarnessModel, HarnessSettingsResponse, ThinkingLevel } from '../lib/api';
import { IconCheck, IconChevron } from './icons';

const LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
};
const LEVELS = Object.keys(LEVEL_LABELS) as ThinkingLevel[];
type OpenMenu = 'model' | 'thinking' | null;

function shortModelLabel(label: string): string {
  return label.split(' · ')[0] || label;
}

export default function SessionControls({
  model, thinking, disabled, onModelChange, onThinkingChange,
}: {
  model?: string;
  thinking?: ThinkingLevel;
  disabled: boolean;
  onModelChange: (model: string) => void;
  onThinkingChange: (thinking: ThinkingLevel | '') => void;
}) {
  const [open, setOpen] = useState<OpenMenu>(null);
  const [catalogs, setCatalogs] = useState<HarnessModel[]>([]);
  const [settings, setSettings] = useState<HarnessSettingsResponse | null>(null);
  const [note, setNote] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const [modelResult, harness] = await Promise.all([
        fetchHarnessModels('pi'),
        fetchHarnessSettings(),
      ]);
      setCatalogs(modelResult.models);
      setSettings(harness);
      setNote('');
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (open) void load(); }, [load, open]);
  useEffect(() => { if (disabled) setOpen(null); }, [disabled]);
  useEffect(() => {
    const refresh = () => { void load(); };
    window.addEventListener('easel:harness-settings-changed', refresh);
    return () => window.removeEventListener('easel:harness-settings-changed', refresh);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const globalModel = settings?.models?.pi || '';
  const globalThinking = (settings?.thinking || '') as ThinkingLevel | '';
  const globalInfo = catalogs.find((item) => item.id === globalModel)
    || catalogs.find((item) => item.default);
  const effectiveModel = model || globalModel || globalInfo?.id || '';
  const effectiveInfo = catalogs.find((item) => item.id === effectiveModel);
  const globalModelLabel = globalInfo ? shortModelLabel(globalInfo.label) : globalModel || 'pi 默认';
  const modelLabel = model
    ? shortModelLabel(catalogs.find((item) => item.id === model)?.label || model)
    : `全局 · ${globalModelLabel}`;
  const thinkingLabel = thinking
    ? LEVEL_LABELS[thinking]
    : `全局 · ${globalThinking ? LEVEL_LABELS[globalThinking] : '默认'}`;
  const availableLevels = (effectiveInfo?.thinkingLevels?.length ? effectiveInfo.thinkingLevels : LEVELS)
    .filter((level, index, list) => list.indexOf(level) === index);
  const thinkingOptions = thinking && !availableLevels.includes(thinking)
    ? [thinking, ...availableLevels]
    : availableLevels;

  const chooseModel = (value: string) => {
    onModelChange(value);
    setOpen(null);
  };
  const chooseThinking = (value: ThinkingLevel | '') => {
    onThinkingChange(value);
    setOpen(null);
  };

  return (
    <div className="composer-session-controls" ref={rootRef}>
      <div className="composer-session-control">
        <button type="button" className="composer-session-btn" disabled={disabled}
          aria-haspopup="menu" aria-expanded={open === 'model'}
          onClick={() => setOpen((value) => (value === 'model' ? null : 'model'))}
          title={`会话模型：${model ? modelLabel : `跟随全局（${globalModelLabel}）`}`}>
          <span className="composer-session-key">模型</span>
          <span className="composer-session-value">{modelLabel}</span>
          <IconChevron size={13} />
        </button>
        {open === 'model' && (
          <div className="composer-session-menu" role="menu">
            <button type="button" className="composer-session-item" role="menuitemradio"
              aria-checked={!model} onClick={() => chooseModel('')}>
              <span className="composer-session-check">{!model && <IconCheck size={13} />}</span>
              <span className="composer-session-item-text">
                <strong>跟随全局</strong>
                <small>{globalModelLabel}</small>
              </span>
            </button>
            <div className="composer-session-divider" />
            {model && !catalogs.some((item) => item.id === model) && (
              <button type="button" className="composer-session-item" role="menuitemradio"
                aria-checked onClick={() => chooseModel(model)}>
                <span className="composer-session-check"><IconCheck size={13} /></span>
                <span className="composer-session-item-text">
                  <strong>{model}</strong>
                  <small>当前 / 自定义</small>
                </span>
              </button>
            )}
            {catalogs.map((item) => (
              <button type="button" key={item.id} className="composer-session-item" role="menuitemradio"
                aria-checked={model === item.id} onClick={() => chooseModel(item.id)}>
                <span className="composer-session-check">{model === item.id && <IconCheck size={13} />}</span>
                <span className="composer-session-item-text">
                  <strong>{shortModelLabel(item.label)}</strong>
                  <small>{item.provider}</small>
                </span>
              </button>
            ))}
            {!catalogs.length && (
              <p className="composer-session-note">{note || '正在读取可用模型…'}</p>
            )}
          </div>
        )}
      </div>

      <div className="composer-session-control composer-session-control--thinking">
        <button type="button" className="composer-session-btn" disabled={disabled}
          aria-haspopup="menu" aria-expanded={open === 'thinking'}
          onClick={() => setOpen((value) => (value === 'thinking' ? null : 'thinking'))}
          title={`会话思考深度：${thinking ? thinkingLabel : `跟随全局（${globalThinking ? LEVEL_LABELS[globalThinking] : '默认'}）`}`}>
          <span className="composer-session-key">思考</span>
          <span className="composer-session-value">{thinkingLabel}</span>
          <IconChevron size={13} />
        </button>
        {open === 'thinking' && (
          <div className="composer-session-menu" role="menu">
            <button type="button" className="composer-session-item" role="menuitemradio"
              aria-checked={!thinking} onClick={() => chooseThinking('')}>
              <span className="composer-session-check">{!thinking && <IconCheck size={13} />}</span>
              <span className="composer-session-item-text">
                <strong>跟随全局</strong>
                <small>{globalThinking ? LEVEL_LABELS[globalThinking] : 'pi 默认'}</small>
              </span>
            </button>
            <div className="composer-session-divider" />
            {thinkingOptions.map((level) => (
              <button type="button" key={level} className="composer-session-item" role="menuitemradio"
                aria-checked={thinking === level} onClick={() => chooseThinking(level)}>
                <span className="composer-session-check">{thinking === level && <IconCheck size={13} />}</span>
                <span className="composer-session-item-text">
                  <strong>{LEVEL_LABELS[level]}</strong>
                  <small>{level}{!availableLevels.includes(level) ? ' · 当前模型会自动调整' : ''}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
