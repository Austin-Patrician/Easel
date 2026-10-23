import { useMemo, useState } from 'react';
import type { ApprovalMode, ChatQuestion, ChatQuestionItem } from '../lib/api';
import { answerQuestion } from '../lib/api';

/**
 * ask_user 问答题卡片。
 *
 * pi 扩展的 ask_user 一次可带 1-3 个问题（question.questions[]）。
 * question.resolve 要求 answers 里**每个问题都有答案**（单个缺失即报
 * QUESTION_INVALID_ANSWER: "question 'xxx' requires an answer"）。
 * 因此多问题时渲染全部题目，用户每问答完一项，全部选齐后自动提交一次。
 *
 * 多选：问题对象带 multiSelect: true 时，answers[qid] 可携带多个 label
 * 前端只按数据的 multiSelect 渲染，不绕过服务端校验。
 */
function QuestionCard({
  question,
  approval,
  onAutoApprove,
  onAnswered,
}: {
  question: ChatQuestion;
  approval: ApprovalMode;
  onAutoApprove?: () => void | Promise<void>;
  onAnswered: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [customVals, setCustomVals] = useState<Record<string, string[]>>({});
  const [showCustom, setShowCustom] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const items: ChatQuestionItem[] = question.questions || [];
  const valsOf = (it: ChatQuestionItem): string[] => selected[it.questionId] || [];
  const allAnswered = items.length > 0 && items.every((it) => valsOf(it).length > 0);
  const permissionCard = items.length === 1
    && items[0].questionId === 'ui_select'
    && items[0].header === '需要确认'
    && (items[0].options || []).some((opt) => opt.label === '允许本次');

  const pick = (it: ChatQuestionItem, label: string) => {
    setSelected((s) => {
      const cur = s[it.questionId] || [];
      const next = it.multiSelect
        ? (cur.includes(label) ? cur.filter((v) => v !== label) : [...cur, label])
        : [label];
      return { ...s, [it.questionId]: next };
    });
  };

  const fillCustom = (it: ChatQuestionItem) => {
    const v = (custom[it.questionId] || '').trim();
    if (!v) return;
    setSelected((s) => {
      const cur = s[it.questionId] || [];
      return { ...s, [it.questionId]: it.multiSelect && !cur.includes(v) ? [...cur, v] : [v] };
    });
    setCustomVals((c) => {
      const cur = c[it.questionId] || [];
      return { ...c, [it.questionId]: cur.includes(v) ? cur : [...cur, v] };
    });
  };

  const removeCustom = (it: ChatQuestionItem, v: string) => {
    setSelected((s) => ({ ...s, [it.questionId]: (s[it.questionId] || []).filter((x) => x !== v) }));
    setCustomVals((c) => ({ ...c, [it.questionId]: (c[it.questionId] || []).filter((x) => x !== v) }));
  };

  const submit = async (autoApprove = false) => {
    const allowAndAuto = autoApprove && permissionCard;
    if (busy || (!allAnswered && !allowAndAuto)) return;
    setBusy(true); setError('');
    const answers: Record<string, string[]> = {};
    for (const it of items) {
      answers[it.questionId] = allowAndAuto ? ['允许本次'] : valsOf(it);
    }
    if (allowAndAuto) setSelected(answers);
    try {
      if (allowAndAuto) await onAutoApprove?.();
      const res = await answerQuestion({ questionId: question.id, answers });
      if (!res.ok) setError(res.error || '提交失败');
      else onAnswered();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="message-row assistant">
      <div className="msg-col assistant" style={{ maxWidth: '80%' }}>
        <div className="question-card">
          {items.map((it, idx) => {
            const options: { label: string; description?: string }[] = it.options || [];
            const vals = valsOf(it);
            const ctl = showCustom[it.questionId];
            const cvals = customVals[it.questionId] || [];
            return (
              <div key={it.questionId} className="question-card__item">
                {idx > 0 && <div className="question-card__divider" />}
                {it.header && <div className="question-card__chip">{it.header}</div>}
                <div className="question-card__title">
                  {it.question || '请选择'}
                  {it.multiSelect && <span className="question-card__multi">可多选</span>}
                </div>
                {it.detail && (
                  <div className={`question-card__detail${expanded[it.questionId] ? ' question-card__detail--open' : ''}`}>
                    <code title={expanded[it.questionId] ? undefined : it.detail}>{it.detail}</code>
                    <button className="question-card__detail-toggle" type="button"
                      aria-expanded={!!expanded[it.questionId]}
                      onClick={() => setExpanded((s) => ({ ...s, [it.questionId]: !s[it.questionId] }))}>
                      {expanded[it.questionId] ? '收起' : '展开'}
                    </button>
                  </div>
                )}
                <div className="question-card__options">
                  {options.map((opt) => (
                    <button key={opt.label}
                      className={`question-card__option${vals.includes(opt.label) ? ' question-card__option--selected' : ''}`}
                      disabled={busy}
                      onClick={() => pick(it, opt.label)}>
                      <strong>{opt.label}</strong>
                      {opt.description && <span>{opt.description}</span>}
                    </button>
                  ))}
                  {cvals.map((v) => (
                    <button key={`custom-${v}`}
                      className="question-card__option question-card__option--selected"
                      disabled={busy}
                      title="点击移除"
                      onClick={() => removeCustom(it, v)}>
                      <strong>{v}</strong>
                      <span>自定义 · 点击移除</span>
                    </button>
                  ))}
                  <button className="question-card__other" disabled={busy}
                    onClick={() => setShowCustom((s) => ({ ...s, [it.questionId]: !s[it.questionId] }))}>
                    {ctl ? '收起自定义输入' : '自行输入…'}
                  </button>
                </div>
                {ctl && (
                  <div className="question-card__custom">
                    <input
                      type="text"
                      value={custom[it.questionId] || ''}
                      placeholder="输入你的答案"
                      onChange={(e) => setCustom((c) => ({ ...c, [it.questionId]: e.target.value }))}
                    />
                    <button disabled={busy || !(custom[it.questionId] || '').trim()}
                      onClick={() => fillCustom(it)}>
                      填入
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {/* 单选题：选完点提交；多题：全部选齐后提交（单选/多选同一规则） */}
          {items.length === 1 ? (
            <div className="question-card__actions">
              {permissionCard && approval === 'manual' && onAutoApprove && (
                <button className="question-card__auto" disabled={busy}
                  onClick={() => void submit(true)}
                  title="允许本次执行，并将本会话后续确认改为自动放行">
                  允许并自动审批后续
                </button>
              )}
              <button className="question-card__submit" disabled={busy || !allAnswered}
                onClick={() => void submit()}>
                提交
              </button>
            </div>
          ) : (
            allAnswered && !busy && (
              <div className="question-card__actions">
                <button className="question-card__submit" disabled={busy} onClick={() => void submit()}>
                  全部已选，提交
                </button>
              </div>
            )
          )}
          {busy && <div className="question-card__hint">已提交，Agent 继续处理中…</div>}
          {error && <div className="question-card__hint question-card__error">{error}</div>}
        </div>
      </div>
    </div>
  );
}

/** 流式中的 ask_user 问答题列表（一次性卡片，答完即从当前流移除）。 */
export default function QuestionCards({
  questions,
  approval = 'manual',
  onAutoApprove,
  onDone,
}: {
  questions: ChatQuestion[];
  approval?: ApprovalMode;
  onAutoApprove?: () => void | Promise<void>;
  onDone?: (questionId: string) => void;
}) {
  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  const visible = useMemo(
    () => questions.filter((q) => !answered[q.id]),
    [questions, answered],
  );
  if (!visible.length) return null;
  return (
    <>
      {visible.map((q) => (
        <QuestionCard key={q.id} question={q} approval={approval} onAutoApprove={onAutoApprove}
          onAnswered={() => {
            setAnswered((a) => ({ ...a, [q.id]: true }));
            onDone?.(q.id);   // 通知 App：此题已答，重放/恢复不再出现
          }} />
      ))}
    </>
  );
}
