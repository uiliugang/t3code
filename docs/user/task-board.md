# Manage local work items

Open **Requirements board**, choose **Local work items**, then choose an environment and project.
Existing tasks keep their conversations, execution history, review results, and archive state.
Create a local task when there is no external issue to track. **Discover** finds recent
conversations you can turn into local tasks without starting an agent or changing the conversation.

Local work items track To do, In progress, In review, and Done. Search within the selected project
and show archived tasks when needed. For MEP ONES and GitHub Issues, use
[automatic delivery tracking](source-control.md#manage-requirements).

## Assign agents

Open a task and choose **Assign agents**. Add the models and assignments you want to run. Each participant gets its own conversation and can use an independent worktree. For a new worktree, set **Base ref** to the branch or commit you intend to start from; the environment's branch policy still applies. You can add more agents while a task is in progress. Stop one participant without stopping its peers, or stop them all from the task.

Each execution keeps the requirements version it started with. Editing the task changes future executions. An older execution's result stays in its history and cannot complete the new requirements.

## Review results

An agent finishing a turn does not complete the task. Wait for the participants to finish or stop the remaining work, select the results you want to use, and submit the task for review. Verify the combined result, then accept it or request changes. Reopen a completed task to continue it. Archive tasks you want to hide and restore them later.

## Continue a conversation

Use **Continue in conversation** to place the task's goal, constraints, acceptance criteria, and previous results in a draft. Existing input is preserved. Send the draft when you are ready. Generating this draft does not call a model.

Web and desktop also offer work items in the conversation's right panel. Mobile provides the same
local task actions in a list and detail view. Data stays on its owning environment; remote clients
read it through their connection.
