import { useEffect, useState } from "react";
import { cn } from "./cn";

export type AskQuestionOption = {
  value: string;
  label: string;
};

export type AskQuestionCardProps = {
  questionNumber?: number;
  questionTotal?: number;
  question: string;
  options?: AskQuestionOption[];
  input?: {
    value: string;
    placeholder: string;
    error?: string | null;
    onChange: (value: string) => void;
    validate?: (value: string) => boolean;
  };
  onSubmit: (value: string) => void;
};

const OPTION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function QuestionsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden className="shrink-0 text-[var(--color-ask-question-icon)]">
      <path
        fill="currentColor"
        d="M12 2C6.48 2 2 6.15 2 11c0 2.76 1.34 5.22 3.45 6.78L4 22l4.55-1.18C9.58 21.59 10.76 22 12 22c5.52 0 10-4.15 10-9s-4.48-9-10-9zm.95 13.8h-1.9v-.63c0-.69.14-1.24.43-1.66.28-.42.8-.9 1.55-1.44.62-.45 1.02-.84 1.2-1.17.18-.33.27-.72.27-1.17 0-.62-.22-1.11-.66-1.47-.44-.36-1.03-.54-1.77-.54-.7 0-1.27.18-1.71.54-.44.36-.7.86-.78 1.5H8.6c.08-1.05.5-1.88 1.26-2.49.76-.61 1.74-.92 2.94-.92 1.2 0 2.14.28 2.82.84.68.56 1.02 1.33 1.02 2.31 0 .58-.14 1.1-.42 1.56-.28.46-.76.97-1.44 1.53-.64.52-1.03.95-1.17 1.29-.14.34-.21.78-.21 1.32v.39zm-1.9 2.45h1.9V18.5h-1.9v.75z"
      />
    </svg>
  );
}

function ChevronIcon({ direction }: { direction: "up" | "down" }) {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden className="text-[var(--color-ask-question-muted)]">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        d={direction === "up" ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"}
      />
    </svg>
  );
}

export function AskQuestionCard({
  questionNumber = 1,
  questionTotal = 1,
  question,
  options = [],
  input,
  onSubmit,
}: AskQuestionCardProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const inputValue = input?.value ?? "";
  const inputValid = input ? (input.validate ? input.validate(inputValue) : inputValue.trim().length > 0) : false;
  const canContinue = input ? inputValid : selectedIndex !== null;

  useEffect(() => {
    setSelectedIndex(null);
  }, [question, options]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        if (event.key === "Enter" && input && inputValid) {
          event.preventDefault();
          onSubmit(inputValue.trim());
        }
        return;
      }
      if (event.key === "Enter" && selectedIndex !== null) {
        event.preventDefault();
        const option = options[selectedIndex];
        if (option) {
          onSubmit(option.value);
        }
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((prev) => {
          if (prev === null) return 0;
          return Math.min(prev + 1, options.length - 1);
        });
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((prev) => {
          if (prev === null) return options.length - 1;
          return Math.max(prev - 1, 0);
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [input, inputValid, inputValue, onSubmit, options, selectedIndex]);

  return (
    <div
      className="ui-ask-question"
      role="group"
      aria-label="Question"
    >
      <header className="ui-ask-question__header">
        <div className="ui-ask-question__title-row">
          <QuestionsIcon />
          <span className="ui-ask-question__title">Questions</span>
        </div>
        <div className="ui-ask-question__pager" aria-label={`Question ${questionNumber} of ${questionTotal}`}>
          <button type="button" className="ui-ask-question__pager-btn" disabled aria-hidden tabIndex={-1}>
            <ChevronIcon direction="up" />
          </button>
          <span className="ui-ask-question__pager-label tabular-nums">
            {questionNumber} of {questionTotal}
          </span>
          <button type="button" className="ui-ask-question__pager-btn" disabled aria-hidden tabIndex={-1}>
            <ChevronIcon direction="down" />
          </button>
        </div>
      </header>

      <div className="ui-ask-question__divider" aria-hidden />

      <div className="ui-ask-question__body">
        <p className="ui-ask-question__prompt">
          {questionNumber}. {question}
        </p>
        {input ? (
          <div className="ui-ask-question__input-wrap">
            <input
              className={cn("ui-ask-question__input", input.error && "ui-ask-question__input--invalid")}
              value={input.value}
              placeholder={input.placeholder}
              onChange={(event) => input.onChange(event.target.value)}
              aria-invalid={Boolean(input.error)}
              autoFocus
            />
            {input.error ? <p className="ui-ask-question__input-error">{input.error}</p> : null}
          </div>
        ) : (
          <ul className="ui-ask-question__options" role="listbox" aria-label="Answer choices">
            {options.map((option, index) => {
              const letter = OPTION_LETTERS[index] ?? String(index + 1);
              const selected = selectedIndex === index;
              return (
                <li key={option.value} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={cn("ui-ask-question__option", selected && "ui-ask-question__option--selected")}
                    onClick={() => setSelectedIndex(index)}
                    onDoubleClick={() => onSubmit(option.value)}
                  >
                    <span className="ui-ask-question__option-badge" aria-hidden>
                      {letter}
                    </span>
                    <span className="ui-ask-question__option-label">{option.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="ui-ask-question__footer">
        <button
          type="button"
          className="ui-ask-question__continue"
          disabled={!canContinue}
          onClick={() => {
            if (input) {
              if (!inputValid) return;
              onSubmit(inputValue.trim());
              return;
            }
            if (selectedIndex === null) return;
            const option = options[selectedIndex];
            if (option) {
              onSubmit(option.value);
            }
          }}
        >
          <span>Continue</span>
          <kbd className="ui-ask-question__kbd ui-ask-question__kbd--continue" aria-hidden>
            ↵
          </kbd>
        </button>
      </footer>
    </div>
  );
}
