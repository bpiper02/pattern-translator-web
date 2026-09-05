import { useEffect, useState, type KeyboardEvent } from "react";

type DraftNumberInputProps = {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (value: number) => void;
  ariaLabel?: string;
};

export function DraftNumberInput({ value, min, max, step = 1, onCommit, ariaLabel }: DraftNumberInputProps) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);

  function commit() {
    setFocused(false);
    const parsed = Number(draft);
    if (!draft.trim() || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.max(min, Math.min(max, parsed));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      setDraft(String(value));
      event.currentTarget.blur();
    }
  }

  return (
    <input
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      value={draft}
      aria-label={ariaLabel}
      onFocus={(event) => {
        setFocused(true);
        event.currentTarget.select();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={handleKeyDown}
    />
  );
}
