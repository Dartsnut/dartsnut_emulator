import type { ProjectType } from "./contracts";
import type { UserLocale } from "./userLocale";

export interface IntakeCardCopy {
  title: string;
  groupAriaLabel: string;
  answerChoicesAriaLabel: string;
  continueLabel: string;
  pagerLabel: (questionNumber: number, questionTotal: number) => string;
  pagerText: (questionNumber: number, questionTotal: number) => string;
}

export interface IntakeCopy {
  projectTypeQuestion: string;
  projectTypeLabels: Record<ProjectType, string>;
  widgetSizeQuestion: string;
  status: {
    noPendingProjectType: string;
    noPendingWidgetSize: string;
    choiceMismatch: string;
  };
  card: IntakeCardCopy;
}

const EN_COPY: IntakeCopy = {
  projectTypeQuestion: "Are you building a game or a widget?",
  projectTypeLabels: {
    game: "Game",
    widget: "Widget"
  },
  widgetSizeQuestion: "Which widget display size do you want?",
  status: {
    noPendingProjectType: "Nothing is waiting for a Game/Widget choice right now — send your idea in the chat first.",
    noPendingWidgetSize: "Nothing is waiting for a widget size choice right now.",
    choiceMismatch: "That choice does not match the current question."
  },
  card: {
    title: "Questions",
    groupAriaLabel: "Question",
    answerChoicesAriaLabel: "Answer choices",
    continueLabel: "Continue",
    pagerLabel: (questionNumber, questionTotal) => `Question ${questionNumber} of ${questionTotal}`,
    pagerText: (questionNumber, questionTotal) => `${questionNumber} of ${questionTotal}`
  }
};

const ZH_HANS_COPY: IntakeCopy = {
  projectTypeQuestion: "你要做游戏还是小组件？",
  projectTypeLabels: {
    game: "游戏",
    widget: "小组件"
  },
  widgetSizeQuestion: "你想要哪种小组件显示尺寸？",
  status: {
    noPendingProjectType: "现在没有等待选择游戏/小组件的问题，请先在聊天里发送你的想法。",
    noPendingWidgetSize: "现在没有等待选择小组件尺寸的问题。",
    choiceMismatch: "这个选项和当前问题不匹配。"
  },
  card: {
    title: "问题",
    groupAriaLabel: "问题",
    answerChoicesAriaLabel: "答案选项",
    continueLabel: "继续",
    pagerLabel: (questionNumber, questionTotal) => `第 ${questionNumber} 个问题，共 ${questionTotal} 个`,
    pagerText: (questionNumber, questionTotal) => `${questionNumber} / ${questionTotal}`
  }
};

const ZH_HANT_COPY: IntakeCopy = {
  projectTypeQuestion: "你要做遊戲還是小組件？",
  projectTypeLabels: {
    game: "遊戲",
    widget: "小組件"
  },
  widgetSizeQuestion: "你想要哪種小組件顯示尺寸？",
  status: {
    noPendingProjectType: "現在沒有等待選擇遊戲/小組件的問題，請先在聊天裡傳送你的想法。",
    noPendingWidgetSize: "現在沒有等待選擇小組件尺寸的問題。",
    choiceMismatch: "這個選項和目前問題不匹配。"
  },
  card: {
    title: "問題",
    groupAriaLabel: "問題",
    answerChoicesAriaLabel: "答案選項",
    continueLabel: "繼續",
    pagerLabel: (questionNumber, questionTotal) => `第 ${questionNumber} 個問題，共 ${questionTotal} 個`,
    pagerText: (questionNumber, questionTotal) => `${questionNumber} / ${questionTotal}`
  }
};

export function getIntakeCopy(locale?: UserLocale | null): IntakeCopy {
  if (locale === "zh-Hans") {
    return ZH_HANS_COPY;
  }
  if (locale === "zh-Hant") {
    return ZH_HANT_COPY;
  }
  return EN_COPY;
}
