import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, MessageCircleQuestionMark } from "lucide-react";
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
  labels?: AskQuestionCardLabels;
  input?: {
    value: string;
    placeholder: string;
    error?: string | null;
    onChange: (value: string) => void;
    validate?: (value: string) => boolean;
  };
  onSubmit: (value: string) => void;
};

export type AskQuestionCardLabels = {
  title: string;
  groupAriaLabel: string;
  answerChoicesAriaLabel: string;
  continueLabel: string;
  pagerLabel: (questionNumber: number, questionTotal: number) => string;
  pagerText: (questionNumber: number, questionTotal: number) => string;
};

const DEFAULT_LABELS: AskQuestionCardLabels = {
  title: "Questions",
  groupAriaLabel: "Question",
  answerChoicesAriaLabel: "Answer choices",
  continueLabel: "Continue",
  pagerLabel: (questionNumber, questionTotal) => `Question ${questionNumber} of ${questionTotal}`,
  pagerText: (questionNumber, questionTotal) => `${questionNumber} of ${questionTotal}`
};

const OPTION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function QuestionsIcon() {
  return <MessageCircleQuestionMark size={14} aria-hidden className="shrink-0 text-[var(--color-ask-question-icon)]" />;
}

function ChevronIcon({ direction }: { direction: "up" | "down" }) {
  const Icon = direction === "up" ? ChevronUp : ChevronDown;
  return <Icon size={10} strokeWidth={2.5} aria-hidden className="text-[var(--color-ask-question-muted)]" />;
}

export function AskQuestionCard({
  questionNumber = 1,
  questionTotal = 1,
  question,
  options = [],
  labels = DEFAULT_LABELS,
  input,
  onSubmit,
}: AskQuestionCardProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const inputValue = input?.value ?? "";
  const inputValid = input ? (input.validate ? input.validate(inputValue) : inputValue.trim().length > 0) : false;
  const canContinue = inputValid || selectedIndex !== null;

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
      aria-label={labels.groupAriaLabel}
    >
      <header className="ui-ask-question__header">
        <div className="ui-ask-question__title-row">
          <QuestionsIcon />
          <span className="ui-ask-question__title">{labels.title}</span>
        </div>
        <div className="ui-ask-question__pager" aria-label={labels.pagerLabel(questionNumber, questionTotal)}>
          <button type="button" className="ui-ask-question__pager-btn" disabled aria-hidden tabIndex={-1}>
            <ChevronIcon direction="up" />
          </button>
          <span className="ui-ask-question__pager-label tabular-nums">
            {labels.pagerText(questionNumber, questionTotal)}
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
        {options.length > 0 ? (
          <ul className="ui-ask-question__options" role="listbox" aria-label={labels.answerChoicesAriaLabel}>
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
                    data-analytics-id="agent_question_option"
                    data-analytics-area="agent"
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
        ) : null}
        {input ? (
          <div className="ui-ask-question__input-wrap">
            <input
              className={cn("ui-ask-question__input", input.error && "ui-ask-question__input--invalid")}
              value={input.value}
              placeholder={input.placeholder}
              onChange={(event) => input.onChange(event.target.value)}
              aria-invalid={Boolean(input.error)}
              autoFocus={options.length === 0}
            />
            {input.error ? <p className="ui-ask-question__input-error">{input.error}</p> : null}
          </div>
        ) : null}
      </div>

      <footer className="ui-ask-question__footer">
        <button
          type="button"
          className="ui-ask-question__continue"
          data-analytics-id="agent_question_continue"
          data-analytics-area="agent"
          disabled={!canContinue}
          onClick={() => {
            if (selectedIndex !== null) {
              const option = options[selectedIndex];
              if (option) {
                onSubmit(option.value);
              }
              return;
            }
            if (input) {
              if (!inputValid) return;
              onSubmit(inputValue.trim());
              return;
            }
          }}
        >
          <span>{labels.continueLabel}</span>
          <kbd className="ui-ask-question__kbd ui-ask-question__kbd--continue" aria-hidden>
            ↵
          </kbd>
        </button>
      </footer>
    </div>
  );
}
