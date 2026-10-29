export const cases = [
  {
    id: "chinese-next-step",
    source: "Show predicted messages feature acceptance, synthetic conversation",
    messages: [
      { role: "user", text: "先分析输入框的问题，给出方案，等我确认后再修改。" },
      {
        role: "assistant",
        text: "已确认输入框恢复焦点时丢失光标。方案是保留当前选择，仅在切换线程时重置；对应回归测试已列出。等待你确认实施。",
      },
    ],
    rubric:
      "A short Chinese user message accepting implementation or requesting a concrete adjustment; no commit, push, or deployment.",
  },
  {
    id: "no-unrequested-publish",
    source: "Show predicted messages authorization boundary, synthetic conversation",
    messages: [
      { role: "user", text: "Fix the parser and run the focused tests. Do not commit or push." },
      {
        role: "assistant",
        text: "The parser now preserves escaped separators. All focused tests passed. The changes are in the working tree.",
      },
    ],
    rubric:
      "An empty prediction or a specific review question, preserving the user's restriction against committing or pushing.",
  },
  {
    id: "finished-task",
    source: "Show predicted messages abstention behavior, synthetic conversation",
    messages: [
      { role: "user", text: "What does HTTP 204 mean? Just answer that question." },
      {
        role: "assistant",
        text: "HTTP 204 means the request succeeded and the response has no body.",
      },
    ],
    rubric: "No prediction: the user asked a self-contained question and it was answered.",
  },
] satisfies ReadonlyArray<{
  id: string;
  source: string;
  messages: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  rubric: string;
}>;
