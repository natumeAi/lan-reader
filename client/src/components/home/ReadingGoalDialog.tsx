import type { FormEvent } from 'react';
import type { GoalKind } from '../../utils/readingStatsFormat.js';
import { useId, useRef, useState } from 'react';
import { useModalDialog } from '../../hooks/useModalDialog.js';
import { GOAL_BOUNDS, parseGoalInput } from '../../utils/readingStatsFormat.js';

export interface ReadingGoalDialogProps {
  /** Currently saved value, used as the initial draft. */
  currentValue: number;
  kind: GoalKind;
  onClose: () => void;
  /** Persists the value; rejects with a user-facing Error when the save fails. */
  onSave: (value: number) => Promise<void>;
}

const COPY: Record<GoalKind, { title: string; label: string; hint: string }> = {
  daily: { title: '每日阅读目标', label: '每天阅读', hint: '按前台阅读时间计算' },
  annual: { title: '年度读完目标', label: '每年读完', hint: '读到最后一页即记为读完' },
};

/**
 * Edits one reading goal. Rendered only while open; the modal owner keeps focus inside,
 * closes on Escape (unless a save is running) and restores focus to the opener.
 */
export function ReadingGoalDialog({ currentValue, kind, onClose, onSave }: ReadingGoalDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(() => String(currentValue));
  const [message, setMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const titleId = useId();
  const inputId = useId();
  const messageId = useId();
  const hintId = useId();
  const copy = COPY[kind];
  const bounds = GOAL_BOUNDS[kind];

  const requestClose = () => {
    if (!isSaving) onClose();
  };
  const { dialogRef, onKeyDown } = useModalDialog({
    initialFocusRef: inputRef,
    onRequestClose: requestClose,
    open: true,
  });

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSaving) return;
    const parsed = parseGoalInput(kind, draft);
    if (!parsed.ok) {
      setMessage(parsed.message);
      inputRef.current?.focus();
      return;
    }
    if (parsed.value === currentValue) {
      onClose();
      return;
    }

    setIsSaving(true);
    setMessage('');
    try {
      await onSave(parsed.value);
      onClose();
    } catch (error) {
      setIsSaving(false);
      setMessage(error instanceof Error && error.message ? error.message : '无法保存阅读目标');
    }
  };

  return (
    <div
      ref={dialogRef}
      className="goal-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div className="goal-dialog-backdrop" aria-hidden="true" onClick={requestClose} />
      <form className="goal-dialog-panel" noValidate onSubmit={(event) => { void handleSubmit(event); }}>
        <h2 id={titleId}>{copy.title}</h2>
        <label className="goal-dialog-field" htmlFor={inputId}>
          <span>{copy.label}</span>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            enterKeyHint="done"
            value={draft}
            readOnly={isSaving}
            aria-invalid={message ? true : undefined}
            aria-describedby={message ? `${messageId} ${hintId}` : hintId}
            onChange={(event) => {
              setDraft(event.target.value);
              if (message) setMessage('');
            }}
          />
          <span>{bounds.unit}</span>
        </label>
        <p className="goal-dialog-hint" id={hintId}>
          {copy.hint}，可设置 {bounds.min}–{bounds.max} {bounds.unit}
        </p>
        {message ? (
          <p className="goal-dialog-message" id={messageId} role="alert">{message}</p>
        ) : null}
        <div className="goal-dialog-actions">
          <button type="button" onClick={requestClose} disabled={isSaving}>取消</button>
          <button className="is-primary" type="submit" disabled={isSaving}>
            {isSaving ? '正在保存' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}
