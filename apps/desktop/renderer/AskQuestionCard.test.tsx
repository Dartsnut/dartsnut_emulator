import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AskQuestionCard } from "./AskQuestionCard";

describe("AskQuestionCard", () => {
  it("renders selectable options and an optional free-text answer together", () => {
    const markup = renderToStaticMarkup(
      <AskQuestionCard
        question="What style should the clock use?"
        options={[
          { value: "digital", label: "Digital" },
          { value: "analog", label: "Analog" }
        ]}
        input={{
          value: "",
          placeholder: "Something else",
          onChange: vi.fn()
        }}
        onSubmit={vi.fn()}
      />
    );
    expect(markup).toContain("Digital");
    expect(markup).toContain("Analog");
    expect(markup).toContain('placeholder="Something else"');
    expect(markup).toContain("Continue");
  });
});
