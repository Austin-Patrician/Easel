export const VOICE_STYLE_PRESETS = [
  {
    label: '冷静拆解',
    hint: '判断句留半拍，句尾收住',
    value: '冷静、克制，像工程师复盘问题：判断句之间留半拍，句尾收住，不煽情。',
  },
  {
    label: '轻松聊天',
    hint: '语速稍快，带一点笑意',
    value: '轻松、口语化，像午休时和同事聊天：语速稍快，带一点笑意，不要播音腔。',
  },
  {
    label: '纪录片旁白',
    hint: '观察者视角，句尾下沉',
    value: '纪录片旁白感：观察者视角，语速偏慢，信息密度高，句尾下沉。',
  },
];

export function voiceStyleLabel(value?: string): string {
  if (!value) return '全局';
  return VOICE_STYLE_PRESETS.find((item) => item.value === value)?.label || '自定义';
}
