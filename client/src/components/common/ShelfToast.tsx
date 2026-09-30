import { useEffect, useRef } from 'react';

export interface ShelfToastAction {
  label: string;
  disabled?: boolean;
  onClick(): void;
}
interface ShelfToastProps {
  message: string;
  actions?: readonly [] | readonly [ShelfToastAction] | readonly [ShelfToastAction, ShelfToastAction];
  light?: boolean;
  duration?: number;
  onDismiss(): void;
}

/** One mounted notice, with a remaining-time deadline shared by hover and keyboard focus. */
export function ShelfToast({ message, actions = [], light = false, duration = 5000, onDismiss }: ShelfToastProps) {
  const element = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    let remaining = duration;
    let started = Date.now();
    let hovered = false;
    let focused = node.contains(document.activeElement);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pause = () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      remaining = Math.max(0, remaining - (Date.now() - started));
    };
    const resume = () => {
      if (hovered || focused || timer !== null) return;
      started = Date.now();
      timer = setTimeout(() => { timer = null; dismiss.current(); }, remaining);
    };
    const enter = () => { hovered = true; pause(); };
    const leave = () => { hovered = false; resume(); };
    const focus = () => { focused = true; pause(); };
    const blur = (event: FocusEvent) => {
      focused = event.relatedTarget instanceof Node && node.contains(event.relatedTarget);
      resume();
    };
    node.addEventListener('mouseenter', enter);
    node.addEventListener('mouseleave', leave);
    node.addEventListener('focusin', focus);
    node.addEventListener('focusout', blur);
    resume();
    return () => {
      pause();
      node.removeEventListener('mouseenter', enter);
      node.removeEventListener('mouseleave', leave);
      node.removeEventListener('focusin', focus);
      node.removeEventListener('focusout', blur);
    };
  }, [duration]);
  const runAction = (action: ShelfToastAction) => {
    // An action replaces this notice. Hand keyboard focus to a surrounding dialog first, so it
    // is not dropped onto the page behind a modal Folder panel.
    const node = element.current;
    if (node?.contains(document.activeElement)) {
      node.parentElement?.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
    }
    action.onClick();
  };
  return (
    <div ref={element} className={`shelf-toast${light ? ' shelf-toast--light' : ''}`} role="status" aria-live="polite">
      <span>{message}</span>
      {actions.map(action => (
        <button type="button" disabled={action.disabled} key={action.label} onClick={() => runAction(action)}>{action.label}</button>
      ))}
    </div>
  );
}
