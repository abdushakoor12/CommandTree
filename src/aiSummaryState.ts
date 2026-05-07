const aiSummaryRuntime: { temporarilyDisabled: boolean } = {
  temporarilyDisabled: true,
};

export function aiSummariesTemporarilyDisabled(): boolean {
  return aiSummaryRuntime.temporarilyDisabled;
}

export function setAiSummariesTemporarilyDisabledForTests(disabled: boolean): void {
  aiSummaryRuntime.temporarilyDisabled = disabled;
}
