import { useState } from 'react';
import { IconCheck } from './icons';
import { VOICE_STYLE_PRESETS } from '../lib/voiceStyle';

export default function VoiceStyleMenu({
  value = '', onSelect,
}: {
  value?: string;
  onSelect: (value: string) => void;
}) {
  const preset = VOICE_STYLE_PRESETS.find((item) => item.value === value);
  const [custom, setCustom] = useState(preset ? '' : value);

  return (
    <>
      <button
        type="button"
        className="composer-submenu-item"
        role="menuitemradio"
        aria-checked={!value}
        onClick={() => onSelect('')}
      >
        <span className="composer-submenu-check">{!value && <IconCheck size={13} />}</span>
        <span><strong>跟随全局</strong><small>MIMO_STYLE_PROMPT</small></span>
      </button>
      <div className="composer-session-divider" />
      {VOICE_STYLE_PRESETS.map((item) => (
        <button
          type="button"
          key={item.label}
          className="composer-submenu-item"
          role="menuitemradio"
          aria-checked={value === item.value}
          onClick={() => onSelect(item.value)}
        >
          <span className="composer-submenu-check">{value === item.value && <IconCheck size={13} />}</span>
          <span><strong>{item.label}</strong><small>{item.hint}</small></span>
        </button>
      ))}
      <div className="composer-session-divider" />
      <div className="composer-style-custom">
        <input
          className="composer-style-input"
          value={custom}
          maxLength={200}
          placeholder="自定义风格（仅本会话）"
          onChange={(event) => setCustom(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && custom.trim()) onSelect(custom.trim());
          }}
        />
        <button
          type="button"
          className="composer-style-apply"
          disabled={!custom.trim()}
          onClick={() => onSelect(custom.trim())}
        >
          应用
        </button>
      </div>
      {value && (
        <button
          type="button"
          className="composer-submenu-item"
          onClick={() => onSelect('')}
        >
          <span className="composer-submenu-check" />
          <span><strong>清除本会话覆盖</strong><small>恢复使用全局配音风格</small></span>
        </button>
      )}
    </>
  );
}
