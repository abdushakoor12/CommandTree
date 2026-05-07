import * as assert from "assert";
import * as vscode from "vscode";
import * as summaryPipeline from "../../semantic/summaryPipeline";
import {
  registerDiscoveredCommands,
  initAiSummaries,
  runSummarisation,
  syncAndSummarise,
  type SummaryDeps,
} from "../../summaryOrchestration";
import { ok, err } from "../../models/Result";
import { setAiSummariesTemporarilyDisabledForTests } from "../../aiSummaryState";
import { createMockTaskItem } from "../helpers/helpers";
import type { CommandItem } from "../../models/TaskItem";
import type { Result } from "../../models/Result";

function createTaskList(): CommandItem[] {
  return [createMockTaskItem({ id: "summary-task", label: "Summary Task", command: "echo hi" })];
}

interface TestHarness {
  deps: {
    workspaceRoot: string;
    treeProvider: { getAllTasks: () => CommandItem[]; refresh: () => Promise<void> };
    quickTasksProvider: { updateTasks: (tasks: CommandItem[]) => void };
  };
  getRefreshCount: () => number;
  getUpdatedTasks: () => number;
}

function createDeps(tasks: CommandItem[] = createTaskList()): TestHarness {
  let refreshCount = 0;
  let updatedTasks = 0;
  return {
    deps: {
      workspaceRoot: "/tmp/workspace",
      treeProvider: {
        getAllTasks: () => tasks,
        refresh: async () => {
          refreshCount += 1;
          await Promise.resolve();
        },
      },
      quickTasksProvider: {
        updateTasks: (nextTasks: CommandItem[]) => {
          updatedTasks = nextTasks.length;
        },
      },
    },
    getRefreshCount: () => refreshCount,
    getUpdatedTasks: () => updatedTasks,
  };
}

function toSummaryDeps(value: TestHarness["deps"]): SummaryDeps {
  return value as SummaryDeps;
}

function patchSummariseAllTasks(impl: typeof summaryPipeline.summariseAllTasks): { restore: () => void } {
  const original = summaryPipeline.summariseAllTasks;
  Object.defineProperty(summaryPipeline, "summariseAllTasks", { configurable: true, value: impl });
  return {
    restore: () => {
      Object.defineProperty(summaryPipeline, "summariseAllTasks", { configurable: true, value: original });
    },
  };
}

function patchRegisterAllCommands(impl: typeof summaryPipeline.registerAllCommands): { restore: () => void } {
  const original = summaryPipeline.registerAllCommands;
  Object.defineProperty(summaryPipeline, "registerAllCommands", { configurable: true, value: impl });
  return {
    restore: () => {
      Object.defineProperty(summaryPipeline, "registerAllCommands", { configurable: true, value: original });
    },
  };
}

function patchInfoMessages(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const original = vscode.window.showInformationMessage;
  Object.defineProperty(vscode.window, "showInformationMessage", {
    configurable: true,
    value: async (message: string) => {
      messages.push(message);
      return await Promise.resolve(undefined);
    },
  });
  return {
    messages,
    restore: () => {
      Object.defineProperty(vscode.window, "showInformationMessage", { configurable: true, value: original });
    },
  };
}

function patchErrorMessages(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const original = vscode.window.showErrorMessage;
  Object.defineProperty(vscode.window, "showErrorMessage", {
    configurable: true,
    value: async (message: string) => {
      messages.push(message);
      return await Promise.resolve(undefined);
    },
  });
  return {
    messages,
    restore: () => {
      Object.defineProperty(vscode.window, "showErrorMessage", { configurable: true, value: original });
    },
  };
}

function patchExecuteCommand(): { calls: { command: string; args: unknown[] }[]; restore: () => void } {
  const calls: { command: string; args: unknown[] }[] = [];
  const original = vscode.commands.executeCommand;
  Object.defineProperty(vscode.commands, "executeCommand", {
    configurable: true,
    value: async (command: string, ...args: unknown[]) => {
      calls.push({ command, args });
      return await Promise.resolve(undefined);
    },
  });
  return {
    calls,
    restore: () => {
      Object.defineProperty(vscode.commands, "executeCommand", { configurable: true, value: original });
    },
  };
}

suite("Summary Orchestration E2E Tests", () => {
  teardown(() => {
    setAiSummariesTemporarilyDisabledForTests(true);
  });

  test("registerDiscoveredCommands skips pipeline when there are no tasks", async () => {
    let called = false;
    const registerPatch = patchRegisterAllCommands(async () => {
      called = true;
      await Promise.resolve();
      return ok(0);
    });
    try {
      await registerDiscoveredCommands(toSummaryDeps(createDeps([]).deps));
    } finally {
      registerPatch.restore();
    }
    assert.strictEqual(called, false, "No-task registration should not call the DB registration pipeline");
  });

  test("runSummarisation refreshes views and reports count when enabled", async () => {
    setAiSummariesTemporarilyDisabledForTests(false);
    const summaryPatch = patchSummariseAllTasks(async () => {
      await Promise.resolve();
      return ok(2);
    });
    const infoPatch = patchInfoMessages();
    const harness = createDeps();
    try {
      await runSummarisation({ ...toSummaryDeps(harness.deps), modelSelectionMode: "automatic" });
    } finally {
      infoPatch.restore();
      summaryPatch.restore();
    }
    assert.strictEqual(harness.getRefreshCount(), 1, "Successful summarisation should refresh the tree once");
    assert.strictEqual(harness.getUpdatedTasks(), 1, "Successful summarisation should refresh quick tasks from the tree");
    assert.ok(
      infoPatch.messages.includes("CommandTree: Summarised 2 commands"),
      "Successful summarisation should report the summarised command count",
    );
  });

  test("runSummarisation shows an error when the summary pipeline fails", async () => {
    setAiSummariesTemporarilyDisabledForTests(false);
    const summaryPatch = patchSummariseAllTasks(async (): Promise<Result<number, string>> => {
      await Promise.resolve();
      return err("boom");
    });
    const errorPatch = patchErrorMessages();
    try {
      await runSummarisation({ ...toSummaryDeps(createDeps().deps), modelSelectionMode: "automatic" });
    } finally {
      errorPatch.restore();
      summaryPatch.restore();
    }
    assert.ok(
      errorPatch.messages.includes("CommandTree: Summary failed — boom"),
      "Failed summarisation should surface the pipeline error to the user",
    );
  });

  test("syncAndSummarise registers commands and summarises when enabled", async () => {
    setAiSummariesTemporarilyDisabledForTests(false);
    let registered = 0;
    let summarised = 0;
    const registerPatch = patchRegisterAllCommands(async () => {
      registered += 1;
      await Promise.resolve();
      return ok(1);
    });
    const summaryPatch = patchSummariseAllTasks(async () => {
      summarised += 1;
      await Promise.resolve();
      return ok(0);
    });
    const infoPatch = patchInfoMessages();
    const harness = createDeps();
    try {
      await syncAndSummarise(toSummaryDeps(harness.deps));
    } finally {
      infoPatch.restore();
      summaryPatch.restore();
      registerPatch.restore();
    }
    assert.strictEqual(harness.getRefreshCount(), 1, "syncAndSummarise should refresh the tree before syncing");
    assert.strictEqual(registered, 1, "syncAndSummarise should register discovered commands");
    assert.strictEqual(summarised, 1, "syncAndSummarise should trigger summarisation when enabled");
  });

  test("initAiSummaries sets the disabled context without starting summarisation", () => {
    const executePatch = patchExecuteCommand();
    try {
      initAiSummaries(toSummaryDeps(createDeps().deps));
    } finally {
      executePatch.restore();
    }
    assert.deepStrictEqual(
      executePatch.calls,
      [{ command: "setContext", args: ["commandtree.aiSummariesEnabled", false] }],
      "Disabled init must only set the false context flag",
    );
  });
});
