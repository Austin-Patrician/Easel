import { useState, useEffect, useRef, useMemo } from 'react';
import {
  fetchTrends, fetchSchedule, fetchOutputs, fetchAccounts, fetchIdeas,
  fetchAnalyticsPlatforms, fetchAccountAnalytics, mediaUrl,
} from '../lib/api';
import type {
  TrendGroup, ScheduleItem, OutputNode, AccountItem, Idea,
  AnalyticsPlatform, AccountAnalytics, AccountWhoami,
} from '../lib/api';
import type { Page } from './Sidebar';
import { getWhoamiCache, verifyStale } from '../lib/whoami';
import {
  IconFire, IconCalendar, IconOutputs, IconChat, IconSkills,
  IconIdea, IconPublish,
} from './icons';
import { CoverageGauge, FunnelChart, MixChart, PulseChart } from './DashboardCharts';
import type { MixDatum } from './DashboardCharts';
import '../styles/dashboard.css';

function fmtNum(n: number | null): string {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 10000) return (n / 10000).toFixed(a >= 100000 ? 0 : 1) + '万';
  return String(n);
}

function growthInfo(n: number | null): { text: string; color: string } | null {
  if (n == null || n === 0) return null;
  return n > 0
    ? { text: `▲+${fmtNum(n)}`, color: 'var(--trend-up)' }
    : { text: `▼${fmtNum(Math.abs(n))}`, color: 'var(--trend-down)' };
}

function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function fromStamp(stamp: number | null | undefined): Date | null {
  if (!stamp) return null;
  return new Date(stamp > 1_000_000_000_000 ? stamp : stamp * 1000);
}

function fmtMonthDay(stamp: number | null | undefined): string {
  const date = fromStamp(stamp);
  if (!date) return '';
  return `${date.getMonth() + 1}.${date.getDate()}`;
}

function fmtHot(hot: string | undefined): string {
  if (!hot) return '';
  if (/[万亿]/.test(hot)) return hot;
  const value = Number(hot);
  if (!Number.isFinite(value)) return hot;
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)}万`;
  return hot;
}

function collectKinds(node: OutputNode, acc = new Set<string>()): Set<string> {
  if (node.type === 'file' && node.kind) acc.add(node.kind);
  for (const child of node.children || []) collectKinds(child, acc);
  return acc;
}

function outputKind(node: OutputNode): string {
  const meta = node.meta?.kind;
  if (meta === 'video') return '视频';
  if (meta === 'audio') return '音频';
  if (meta === 'article' || meta === 'xhs-note') return '图文';
  if (meta === 'cards' || meta === 'poster') return '卡片';
  const kinds = collectKinds(node);
  if (kinds.has('video')) return '视频';
  if (kinds.has('image')) return '图文';
  if (kinds.has('audio')) return '音频';
  if (kinds.has('text')) return '文档';
  return '其他';
}

function findPreview(node: OutputNode): OutputNode | null {
  for (const child of node.children || []) {
    if (child.type === 'file' && child.kind === 'image' && /\.(png|jpe?g|webp|gif)$/i.test(child.name)) return child;
  }
  for (const child of node.children || []) {
    if (child.type === 'dir') {
      const found = findPreview(child);
      if (found) return found;
    }
  }
  return null;
}

interface DashboardProps {
  persona: string;
  runtimeStatus: string;
  agentRuntime: string;
  onNavigate: (page: Page) => void;
  onUseTopic: (title: string) => void;
}

const STATUS_LABEL: Record<string, string> = { idea: '选题', draft: '草稿', scheduled: '待发', published: '已发' };
type Range = 7 | 14 | 30;

function PanelHead({ kicker, title, action, onAction }: {
  kicker: string;
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="db-panel-head">
      <div>
        <span className="db-kicker">{kicker}</span>
        <h2>{title}</h2>
      </div>
      {action && onAction && <button className="db-more" onClick={onAction}>{action} <span>↗</span></button>}
    </div>
  );
}

export default function DashboardPage({ persona, runtimeStatus, agentRuntime, onNavigate, onUseTopic }: DashboardProps) {
  const [trends, setTrends] = useState<TrendGroup[]>([]);
  const [schedule, setSchedule] = useState<ScheduleItem[]>([]);
  const [outputs, setOutputs] = useState<OutputNode[]>([]);
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [range, setRange] = useState<Range>(7);
  const [anaPlats, setAnaPlats] = useState<AnalyticsPlatform[]>([]);
  const [anaSel, setAnaSel] = useState('');
  const [anaData, setAnaData] = useState<Record<string, AccountAnalytics | 'loading' | 'error'>>(() => {
    try {
      const cache = JSON.parse(localStorage.getItem('easel_analytics') || '{}') as Record<string, AccountAnalytics | 'loading' | 'error'>;
      return Object.fromEntries(Object.entries(cache).filter(([platform, value]) =>
        value && typeof value === 'object' && value.platform === platform
        && typeof value.loggedIn === 'boolean'));
    } catch { return {}; }
  });
  const anaPending = useRef(new Set<string>());
  const [anaErrors, setAnaErrors] = useState<Record<string, string>>({});
  const [anaWin, setAnaWin] = useState<'last' | 'day' | 'week' | 'month' | 'year'>('week');
  const [whoamiMap, setWhoamiMap] = useState<Record<string, AccountWhoami>>(() => getWhoamiCache());
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    fetchTrends('weibo,douyin', 6).then((d) => setTrends(d.trends)).catch(() => {});
    fetchSchedule().then(setSchedule).catch(() => {});
    fetchOutputs().then(setOutputs).catch(() => {});
    fetchAccounts().then(setAccounts).catch(() => {});
    fetchIdeas().then(setIdeas).catch(() => {});
    fetchAnalyticsPlatforms().then((ps) => {
      setAnaPlats(ps);
      const cache = getWhoamiCache();
      const isLog = (p: AnalyticsPlatform) => p.loggedIn || !!cache[p.platform]?.loggedIn;
      const first = ps.find(isLog);
      if (first) setAnaSel((s) => s || first.platform);
      const API_BASED = new Set(['bilibili', 'wechat-oa']);
      verifyStale(ps.filter((p) => !API_BASED.has(p.platform)).map((p) => p.platform), {
        alive: () => aliveRef.current,
        onUpdate: (platform, r) => {
          setWhoamiMap((m) => ({ ...m, [platform]: r }));
          if (r.loggedIn) setAnaSel((s) => s || platform);
        },
      });
    }).catch(() => {});
  }, []);

  const runAna = (platform: string) => {
    setAnaSel(platform);
    if (anaPending.current.has(platform)) return;
    anaPending.current.add(platform);
    setAnaErrors((errors) => ({ ...errors, [platform]: '' }));
    setAnaData((d) => ({ ...d, [platform]: 'loading' }));
    fetchAccountAnalytics(platform)
      .then((r) => setAnaData((d) => {
        const next = { ...d, [platform]: r };
        const cache = Object.fromEntries(Object.entries(next).filter(([, value]) =>
          value && typeof value === 'object'));
        try { localStorage.setItem('easel_analytics', JSON.stringify(cache)); } catch { /* quota */ }
        return next;
      }))
      .catch((error: unknown) => {
        setAnaErrors((errors) => ({ ...errors, [platform]: error instanceof Error
          ? error.message : '抓取失败，请稍后重试' }));
        setAnaData((d) => ({ ...d, [platform]: 'error' as const }));
      })
      .finally(() => anaPending.current.delete(platform));
  };

  const hour = new Date().getHours();
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '上午好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  const today = new Date();
  const todayStr = ymd(today);
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][today.getDay()];
  const dateLabel = `${today.getMonth() + 1}月${today.getDate()}日`;
  const upcoming = [...schedule]
    .filter((s) => s.date >= todayStr && s.status !== 'published')
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).slice(0, 5);
  const recent = outputs.slice(0, 3);
  const pendingIdeas = ideas.filter((i) => i.status === 'pending');
  const loggedIn = accounts.filter((a) => a.loggedIn).length;
  const outputFiles = outputs.reduce((sum, item) => sum + (item.fileCount ?? item.children?.length ?? 0), 0);

  const computed = useMemo(() => {
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const days = Array.from({ length: 30 }, (_, index) => {
      const date = new Date(todayDate);
      date.setDate(date.getDate() - (29 - index));
      return {
        date,
        key: ymd(date),
        label: `${date.getMonth() + 1}.${date.getDate()}`,
        outputs: 0,
        ideas: 0,
        total: 0,
      };
    });
    const dayMap = new Map(days.map((day) => [day.key, day]));
    for (const output of outputs) {
      const date = fromStamp(output.mtime);
      const day = date ? dayMap.get(ymd(date)) : undefined;
      if (day) {
        day.outputs += 1;
        day.total += 1;
      }
    }
    for (const idea of ideas) {
      const date = fromStamp(idea.created);
      const day = date ? dayMap.get(ymd(date)) : undefined;
      if (day) {
        day.ideas += 1;
        day.total += 1;
      }
    }

    const visibleDays = days.slice(-range);
    const rangeOutputs = visibleDays.reduce((sum, day) => sum + day.outputs, 0);
    const rangeIdeas = visibleDays.reduce((sum, day) => sum + day.ideas, 0);
    const rangeTotal = rangeOutputs + rangeIdeas;
    const peak = visibleDays.reduce((max, day) => Math.max(max, day.total), 0);

    const mixMap = new Map<string, number>();
    for (const output of outputs) {
      const kind = outputKind(output);
      mixMap.set(kind, (mixMap.get(kind) || 0) + 1);
    }
    const colors: Record<string, string> = {
      视频: '#d97958',
      图文: '#4059a8',
      音频: '#1d9a97',
      卡片: '#c49b55',
      文档: '#8693a5',
      其他: '#9aa2ae',
    };
    const mix: MixDatum[] = [...mixMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value, color: colors[label] || colors.其他 }));

    const stages = [
      { key: 'idea', label: '选题', value: pendingIdeas.length + schedule.filter((item) => item.status === 'idea').length, color: '#d98661' },
      { key: 'draft', label: '草稿', value: ideas.filter((item) => item.status === 'doing').length + schedule.filter((item) => item.status === 'draft').length, color: '#c4a05a' },
      { key: 'scheduled', label: '待发', value: schedule.filter((item) => item.status === 'scheduled').length, color: '#4059a8' },
      { key: 'published', label: '已发', value: ideas.filter((item) => item.status === 'done').length + schedule.filter((item) => item.status === 'published').length, color: '#1d9a97' },
    ];

    const signals = trends.flatMap((group) =>
      group.items.slice(0, 2).map((item) => ({ ...item, platform: group.label })),
    ).slice(0, 5);

    return { days: visibleDays, rangeOutputs, rangeIdeas, rangeTotal, peak, mix, stages, signals };
  }, [outputs, ideas, schedule, trends, pendingIdeas.length, range]);

  const stageTotal = computed.stages.reduce((sum, stage) => sum + stage.value, 0);
  const publishRate = stageTotal > 0 ? Math.round((computed.stages[3].value / stageTotal) * 100) : 0;
  const coverage = accounts.length > 0 ? Math.round((loggedIn / accounts.length) * 100) : 0;

  const quick: { label: string; page: Page; Icon: typeof IconChat }[] = [
    { label: '开始创作', page: 'chat', Icon: IconChat },
    { label: '看热点', page: 'trends', Icon: IconFire },
    { label: '拆爆款', page: 'breakdown', Icon: IconSkills },
    { label: '记选题', page: 'ideas', Icon: IconIdea },
    { label: '排日历', page: 'calendar', Icon: IconCalendar },
    { label: '去发布', page: 'publish', Icon: IconPublish },
  ];

  const nextSteps = [
    { label: '待做选题', value: pendingIdeas.length, meta: `${ideas.length} 个选题在库`, page: 'ideas' as Page },
    { label: '待发排期', value: upcoming.length, meta: `${publishRate}% 发布转化`, page: 'calendar' as Page },
    { label: '内容项目', value: outputs.length, meta: `${outputFiles} 个文件沉淀`, page: 'outputs' as Page },
  ];

  const statusText = runtimeStatus === 'connected'
    ? (agentRuntime === 'pi' ? 'pi SDK 在线' : '服务在线')
    : '服务未连接';
  const statusDetail = runtimeStatus === 'connected'
    ? 'pi SDK 已就绪；模型登录及可用性请发送消息验证。'
    : 'pi 尚未就绪，请在设置页添加供应商、运行 pi /login，或配置 .env 中的 EASEL_DIRECT_API_*。';

  return (
    <div className="page-scroll dash-page db-page">
      <div className="db-shell">
        <header className="db-topbar">
          <div className="db-topbar-main">
            <div className="db-eyebrow">
              <span className="db-date">{weekday} · {dateLabel}</span>
              <span className={`db-runtime${runtimeStatus === 'connected' ? ' is-online' : ''}`} title={statusDetail}>
                <i /> {statusText}
              </span>
            </div>
            <h1 className="db-greeting">{greet}，<span>{persona || '创作者'}</span></h1>
            <p className="db-note">
              {persona ? `当前画像「${persona}」，工作台按你的内容节奏汇总。` : '通用模式。指定画像后，选题和内容建议会更贴合。'}
            </p>
          </div>
          <div className="db-topbar-side">
            <div className="db-quick">
              {quick.map((item, index) => (
                <button
                  key={item.page}
                  className={`db-quick-btn${index === 0 ? ' is-primary' : ''}`}
                  onClick={() => onNavigate(item.page)}
                >
                  <item.Icon size={14} /><span>{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        </header>

        <div className="db-grid">
          <section className="db-panel db-span-8 db-pulse">
            <div className="db-panel-head">
              <div>
                <span className="db-kicker">OUTPUT VELOCITY</span>
                <h2>内容产出脉搏</h2>
              </div>
              <div className="db-range" role="group" aria-label="时间范围">
                {([7, 14, 30] as Range[]).map((days) => (
                  <button
                    key={days}
                    className={range === days ? 'is-on' : ''}
                    aria-pressed={range === days}
                    onClick={() => setRange(days)}
                  >{days} 天</button>
                ))}
              </div>
            </div>

            <div className="db-pulse-kpis">
              <div className="db-kpi-main">
                <span>近 {range} 天总动态</span>
                <strong>{computed.rangeTotal}</strong>
              </div>
              <div className="db-kpi"><span>产物</span><strong>{computed.rangeOutputs}</strong></div>
              <div className="db-kpi"><span>选题</span><strong>{computed.rangeIdeas}</strong></div>
              <div className="db-kpi"><span>单日峰值</span><strong>{computed.peak}</strong></div>
            </div>

            <div className="db-chart db-chart-pulse">
              <PulseChart data={computed.days} />
            </div>

            <div className="db-legend">
              <span><i className="db-dot" style={{ background: 'var(--accent-start)' }} />总动态</span>
              <span><i className="db-dot" style={{ background: '#d98661' }} />产物</span>
              <span><i className="db-dot" style={{ background: '#4059a8' }} />选题</span>
              <span className="db-legend-note">按创建/更新时间归集</span>
            </div>
          </section>

          <aside className="db-panel db-panel-ink db-span-4 db-matrix">
            <PanelHead kicker="MATRIX" title="账号矩阵" action="管理" onAction={() => onNavigate('accounts')} />
            <div className="db-gauge">
              <CoverageGauge count={loggedIn} total={accounts.length} />
            </div>
            <div className="db-platforms">
              {accounts.length === 0 && <span className="db-rail-empty">还没有配置发布账号。</span>}
              {accounts.map((account) => (
                <span key={account.platform} className={`db-platform${account.loggedIn ? ' is-on' : ''}`} title={account.note || account.name}>
                  <i />{account.name}
                </span>
              ))}
            </div>
            <div className="db-ink-divider" />
            <div className="db-next-head">
              <span className="db-kicker is-ink">NEXT</span>
              <span>{coverage}% 覆盖</span>
            </div>
            <div className="db-next-list">
              {nextSteps.map((step) => (
                <button key={step.label} className="db-next-row" onClick={() => onNavigate(step.page)}>
                  <span>
                    <strong>{step.value}</strong>
                    <span>{step.label}<small>{step.meta}</small></span>
                  </span>
                  <em>↗</em>
                </button>
              ))}
            </div>
          </aside>

          <section className="db-panel db-span-5 db-funnel">
            <PanelHead kicker="PIPELINE" title="内容流水线" action="打开日历" onAction={() => onNavigate('calendar')} />
            <div className="db-chart db-chart-funnel">
              <FunnelChart data={computed.stages} />
              {stageTotal === 0 && <span className="db-chart-empty">还没有进入流水线的内容</span>}
            </div>
            <div className="db-funnel-foot">
              <span><strong>{stageTotal}</strong> 条流转</span>
              <span><strong>{computed.stages[2].value}</strong> 条待发</span>
              <span><strong>{publishRate}%</strong> 发布转化</span>
            </div>
          </section>

          <section className="db-panel db-span-3 db-mix">
            <PanelHead kicker="FORMAT MIX" title="内容形态" action="内容库" onAction={() => onNavigate('outputs')} />
            <div className="db-chart db-donut">
              <MixChart data={computed.mix} total={outputs.length} />
            </div>
            <div className="db-mix-legend">
              {computed.mix.length === 0 && <span className="db-muted-line">还没有内容项目</span>}
              {computed.mix.map((segment) => (
                <div key={segment.label} className="db-mix-row">
                  <span className="db-dot" style={{ background: segment.color }} />
                  <span>{segment.label}</span>
                  <strong>{segment.value}</strong>
                </div>
              ))}
            </div>
          </section>

          <section className="db-panel db-span-4 db-signals">
            <PanelHead kicker="SIGNALS" title="热点雷达" action="全部热点" onAction={() => onNavigate('trends')} />
            <div className="db-signal-list">
              {computed.signals.length === 0 && (
                <div className="db-empty"><span className="db-empty-mark">?</span><span>热点加载中，稍候再试。</span></div>
              )}
              {computed.signals.map((signal, index) => (
                <button key={`${signal.platform}-${signal.title}`} className="db-signal" onClick={() => onUseTopic(signal.title)} title="用这个选题开始创作">
                  <span className="db-signal-rank">{String(index + 1).padStart(2, '0')}</span>
                  <span className="db-signal-main">
                    <strong>{signal.title}</strong>
                    <small>{signal.platform}{signal.hot ? ` · ${fmtHot(signal.hot)}` : ''}</small>
                  </span>
                  <span className="db-signal-go">↗</span>
                </button>
              ))}
            </div>
          </section>

          <section className="db-panel db-span-7 db-gallery">
            <PanelHead kicker="RECENT WORK" title="最近产物" action="内容库" onAction={() => onNavigate('outputs')} />
            {recent.length === 0 ? (
              <div className="db-empty"><span className="db-empty-mark">+</span><span>还没有产物，去对话里生成第一个内容项目。</span></div>
            ) : (
              <div className="db-gallery-grid">
                {recent.map((item) => {
                  const preview = findPreview(item);
                  return (
                    <button key={item.path} className="db-output-card" onClick={() => onNavigate('outputs')}>
                      <span className="db-output-thumb">
                        {preview
                          ? <img src={mediaUrl(preview.path)} alt="" loading="lazy" referrerPolicy="no-referrer" />
                          : <span className="db-output-ph"><IconOutputs size={22} /></span>}
                        <span className="db-output-kind">{outputKind(item)}</span>
                      </span>
                      <span className="db-output-copy">
                        <strong>{item.meta?.title || item.name}</strong>
                        <small>{item.fileCount ?? 0} 个文件 · {fmtMonthDay(item.mtime)}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="db-panel db-span-5 db-agenda">
            <PanelHead kicker="AGENDA" title="接下来的排期" action="排期" onAction={() => onNavigate('calendar')} />
            {upcoming.length === 0 ? (
              <div className="db-empty db-empty-tall">
                <span className="db-empty-mark">·</span>
                <div><strong>未来还没有排期</strong><span>把选题变成内容，再安排一个发布时间。</span></div>
                <button className="db-text-btn" onClick={() => onNavigate('calendar')}>去排期</button>
              </div>
            ) : (
              <div className="db-agenda-list">
                {upcoming.map((item) => (
                  <button key={item.id} className="db-agenda-row" onClick={() => onNavigate('calendar')}>
                    <span className="db-agenda-date">{item.date.slice(5).replace('-', '.')}</span>
                    <span className="db-agenda-main">
                      <strong>{item.title}</strong>
                      <small>{item.platform || '未指定平台'}{item.time ? ` · ${item.time}` : ''}</small>
                    </span>
                    <span className={`badge${item.status === 'scheduled' ? ' is-scheduled' : ''}`}>{STATUS_LABEL[item.status] || item.status}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="db-panel db-span-4 db-ideas">
            <PanelHead kicker="BACKLOG" title="选题栈" action="全部选题" onAction={() => onNavigate('ideas')} />
            {pendingIdeas.length === 0 ? (
              <div className="db-empty db-empty-tall">
                <span className="db-empty-mark">·</span>
                <div><strong>没有待做选题</strong><span>从热点里收一个，或者直接记下想法。</span></div>
                <button className="db-text-btn" onClick={() => onNavigate('trends')}>看热点</button>
              </div>
            ) : (
              <div className="db-idea-list">
                {pendingIdeas.slice(0, 5).map((idea) => (
                  <button key={idea.id} className="db-idea-row" onClick={() => onUseTopic(idea.title)} title="用这个选题开始创作">
                    <span className="db-idea-bullet" />
                    <span className="db-idea-title">{idea.title}</span>
                    {idea.source && <span className="badge">{idea.source}</span>}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="db-panel db-span-8 db-attribution">
            <PanelHead
              kicker="ATTRIBUTION"
              title="账号创作数据"
              action={anaSel && anaData[anaSel] && anaData[anaSel] !== 'loading' ? '刷新' : undefined}
              onAction={() => runAna(anaSel)}
            />
            {(() => {
              const logged = anaPlats.filter((p) => p.loggedIn || whoamiMap[p.platform]?.loggedIn);
              if (anaPlats.length === 0) return <div className="db-empty"><span className="db-empty-mark">?</span><span>账号数据加载中，稍候再试。</span></div>;
              if (logged.length === 0) {
                return (
                  <div className="db-empty db-empty-tall" onClick={() => onNavigate('accounts')} style={{ cursor: 'pointer' }}>
                    <span className="db-empty-mark">+</span>
                    <div><strong>连接账号，让数据开始说话</strong><span>登录后查看粉丝、互动、发布笔记与增长对比。</span></div>
                    <button className="db-text-btn">去账号页</button>
                  </div>
                );
              }
              const d = anaSel ? anaData[anaSel] : undefined;
              const WIN: [typeof anaWin, string][] = [
                ['last', '较上次'], ['day', '较昨日'], ['week', '较上周'], ['month', '较上月'], ['year', '较去年'],
              ];
              return (
                <>
                  <div className="ana-plats">
                    {logged.map((p) => (
                      <button key={p.platform} className={`chip ${anaSel === p.platform ? 'active' : ''}`}
                        onClick={() => runAna(p.platform)}>{p.name}</button>
                    ))}
                  </div>
                  {!d && <div className="db-empty"><span>选择平台查看账号数据。</span></div>}
                  {d === 'loading' && (
                    <div className="loading" style={{ padding: '28px 0' }}><div className="spinner" />抓取中，首次登录态抓取平台数据可能较慢。</div>
                  )}
                  {d === 'error' && (
                    <div className="db-empty" style={{ color: 'var(--red)' }}><span>{anaErrors[anaSel] || '抓取失败，请稍后重试'}，可稍后重试或检查平台登录态。</span></div>
                  )}
                  {d && d !== 'loading' && d !== 'error' && (!d.loggedIn ? (
                    <div className="db-empty" onClick={() => onNavigate('accounts')} style={{ cursor: 'pointer' }}>
                      <span>该平台登录态失效，去账号页重登。</span>
                    </div>
                  ) : (
                    <div className="ana-body">
                      {d.warning && <div className="db-empty" role="status" style={{ gridColumn: '1 / -1' }}><span>{d.warning}</span></div>}
                      <div className="ana-col ana-col-main">
                        <div className="ana-id">{d.nickname ? `@${d.nickname}` : d.name}</div>
                        <div className="ana-overview">
                          {([['粉丝', 'followers'], ['获赞', 'likes'], ['关注', 'following']] as const).map(([label, key]) => {
                            const w = d.growth?.[anaWin] ?? null;
                            const g = w ? growthInfo(w[key as 'followers' | 'likes']) : null;
                            return (
                              <div key={key} className="ana-stat">
                                <div className="ana-stat-val">{fmtNum(d[key])}</div>
                                <div className="ana-stat-label">{label}</div>
                                {g ? <div className="ana-stat-delta" style={{ color: g.color }}>{g.text}</div>
                                  : <div className="ana-stat-delta ana-muted">—</div>}
                              </div>
                            );
                          })}
                        </div>
                        <div className="ana-wins">
                          {WIN.map(([k, lab]) => (
                            <button key={k} className={`ana-win ${anaWin === k ? 'on' : ''}`}
                              onClick={() => setAnaWin(k)}>{lab}</button>
                          ))}
                        </div>
                        <div className="ana-wins-note">
                          {d.growth?.[anaWin]?.since_days != null
                            ? `对比 ${d.growth[anaWin]!.since_days} 天前的快照`
                            : '暂无该时间范围历史快照，可刷新几次后积累对比'}
                        </div>
                      </div>

                      <div className="ana-col ana-col-metrics">
                        <div className="ana-sub">近 7 天 · 核心指标</div>
                        {(d.metrics ?? []).length === 0 ? (
                          <div className="db-empty"><span>该平台未提供近 7 天指标。</span></div>
                        ) : (
                          <div className="ana-metrics">
                            {(d.metrics ?? []).map((m) => {
                              const vs = m.vs ?? '';
                              const up = vs.startsWith('+');
                              const has = vs && vs !== '-';
                              return (
                                <div key={m.label} className="ana-metric">
                                  <div className="ana-metric-val">{m.value}</div>
                                  <div className="ana-metric-label">{m.label}</div>
                                  {has && <div className="ana-metric-vs" style={{ color: up ? 'var(--trend-up)' : 'var(--trend-down)' }}>较 {vs}</div>}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div className="ana-col ana-col-notes">
                        <div className="ana-sub">最近笔记</div>
                        {(d.notes ?? []).length === 0 ? (
                          <div className="db-empty"><span>该账号暂无可读取的已发布笔记。</span></div>
                        ) : (
                          <div className="ana-notes">
                            {(d.notes ?? []).slice(0, 6).map((n, i) => (
                              <a key={i} className="ana-note" href={n.url} target="_blank" rel="noreferrer" title={n.title}>
                                {n.cover
                                  ? <img className="ana-note-cover" src={n.cover} alt="" referrerPolicy="no-referrer" />
                                  : <span className="ana-note-cover ana-note-cover-ph">?</span>}
                                <span className="ana-note-main">
                                  <span className="ana-note-title">{n.title || '(无标题)'}</span>
                                  {n.stat && <span className="ana-note-stat">{n.stat}</span>}
                                </span>
                                <span className="ana-note-go">↗</span>
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </>
              );
            })()}
          </section>
        </div>
      </div>
    </div>
  );
}
