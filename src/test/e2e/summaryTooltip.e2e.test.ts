/**
 * Ensures DB-seeded AI summary content stays hidden while the feature is disabled.
 *
 * A real AI pipeline only runs with Copilot auth (excluded from CI), so this
 * test seeds the SQLite summary row directly via the DB's public API.
 */

import * as assert from "assert";
import {
  activateExtension,
  collectLeafTasks,
  getCommandTreeProvider,
  refreshTasks,
  getTooltipText,
} from "../helpers/helpers";
import type { CommandTreeItem } from "../../models/TaskItem";
import { upsertSummary, computeContentHash } from "../../db/db";
import { getDbOrThrow } from "../../db/lifecycle";

const WARNING_TEXT = "Runs destructive rm -rf";
const SUMMARY_TEXT = "Removes build artifacts and clears the workspace";

suite("Summary and Security Warning Rendering E2E Tests", () => {
  suiteSetup(async function () {
    this.timeout(30000);
    await activateExtension();
  });

  test("tree item hides summary and security warning seeded in the DB while AI summaries are disabled", async function () {
    this.timeout(20000);

    await refreshTasks();
    const tasks = await collectLeafTasks(getCommandTreeProvider());
    const target = tasks[0];
    assert.ok(target !== undefined, "Expected at least one discovered task");

    const handle = getDbOrThrow();
    upsertSummary({
      handle,
      commandId: target.id,
      contentHash: computeContentHash(target.command),
      summary: SUMMARY_TEXT,
      securityWarning: WARNING_TEXT,
    });

    await refreshTasks();

    const provider = getCommandTreeProvider();
    const all = provider.getAllTasks();
    const updated = all.find((t) => t.id === target.id);
    assert.ok(updated !== undefined, "Task should still be in the tree after refresh");
    assert.strictEqual(updated.summary, undefined, "Task should not expose seeded summary while AI summaries are off");
    assert.strictEqual(
      updated.securityWarning,
      undefined,
      "Task should not expose seeded security warning while AI summaries are off"
    );

    const item = await findItemById(target.id);
    assert.ok(item !== undefined, `Must find the command node for ${target.id} in the rendered tree`);

    const labelText = typeof item.label === "string" ? item.label : (item.label?.label ?? "");
    assert.ok(!labelText.includes("⚠"), "Label must not carry the warning glyph while AI summaries are off");

    const tooltip = getTooltipText(item);
    assert.ok(!tooltip.includes(WARNING_TEXT), "Tooltip must not render the seeded security warning");
    assert.ok(!tooltip.includes(SUMMARY_TEXT), "Tooltip must not render the seeded summary");
  });
});

async function findItemById(taskId: string): Promise<CommandTreeItem | undefined> {
  const provider = getCommandTreeProvider();
  const roots = await provider.getChildren();
  for (const root of roots) {
    const found = await searchTree(root, taskId);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

async function searchTree(node: CommandTreeItem, taskId: string): Promise<CommandTreeItem | undefined> {
  if (node.id === taskId) {
    return node;
  }
  const children = await getCommandTreeProvider().getChildren(node);
  for (const child of children) {
    const found = await searchTree(child, taskId);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}
