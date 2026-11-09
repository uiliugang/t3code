# Manage work on the task board

Open **Task board** from the sidebar or command palette, then choose an environment and project. Create a task with a goal, constraints, and acceptance criteria. **Discover** finds recent conversations you can turn into tasks. Discovery uses local rules and does not start an agent or change the conversation.

The task board tracks T3 tasks through To do, In progress, In review, and Done. Search within the
selected project and show archived tasks when needed. Use the
[requirements board](source-control.md#manage-requirements) to manage MEP ONES or GitHub Issues;
those external work items are separate from T3 tasks.

## Assign agents

Open a task and choose **Assign agents**. Add the models and assignments you want to run. Each participant gets its own conversation and can use an independent worktree. For a new worktree, set **Base ref** to the branch or commit you intend to start from; the environment's branch policy still applies. You can add more agents while a task is in progress. Stop one participant without stopping its peers, or stop them all from the task.

Each execution keeps the requirements version it started with. Editing the task changes future executions. An older execution's result stays in its history and cannot complete the new requirements.

## Review results

An agent finishing a turn does not complete the task. Wait for the participants to finish or stop the remaining work, select the results you want to use, and submit the task for review. Verify the combined result, then accept it or request changes. Reopen a completed task to continue it. Archive tasks you want to hide and restore them later.

## Continue a conversation

Use **Continue in conversation** to place the task's goal, constraints, acceptance criteria, and previous results in a draft. Existing input is preserved. Send the draft when you are ready. Generating this draft does not call a model.

Web and desktop also offer the board in the conversation's right panel. Mobile provides the same task actions in a list and detail view. Task data stays on its owning environment; remote clients read it through their connection. Background AI analysis is not enabled by this feature.
