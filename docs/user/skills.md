# Skills

Open **Settings > Skills** and select the environment whose files you want to manage. The list combines managed skills and discoveries from providers and configured usage locations. Duplicate physical locations are grouped; plugin-owned skills stay under their plugin's management. Paths and credentials always belong to the selected environment, including over a remote connection.

Install from a local directory, a Git repository or URL, or an enabled Meituan Skills source. A package containing several skills offers a choice. Without a usage location, the skill is saved only to the library. Use **Installation sources** to configure and check installers. **Usage locations** adds directories to scan and link, including shared directories and custom agent platforms.

To manage an existing skill, review its source, content and locations first. **Copy to library** preserves the original files. **Take over selected locations** backs them up before replacing the selected locations with managed links. A takeover without an independent update source remains a local snapshot; connect its real upstream to enable updates. Sources are never inferred from a skill's name alone.

New managed skills default to **Automatic updates**: the environment server checks daily, prepares changes and applies them when agents are idle. The page does not need to stay open. **Manual updates** checks daily and shows an available-update indicator until you apply the candidate. **No updates** disables scheduled checks and application. Existing policies are retained until you change them. Restoring an earlier version pins it. Change the policy to resume automatic updates. Running provider sessions may need to be reloaded or replaced to use updated files.

Local edits and location conflicts block automatic application without changing your policy. Review the file differences, keep and pin local changes, or explicitly use the candidate version. Cancel a waiting update to leave the current files in place. A later check can discover new content. Batch actions run serially and show individual, persistent results in recent operations; being queued does not mean an update has been applied.

Removing a usage location detaches its managed link. **Stop managing, keep files** leaves ordinary files at the linked locations. **Restore original locations** restores adoption backups and stops management. **Uninstall** removes the managed package and links and restores original adoption backups. Library versions and backups retained after stopping management remain in the environment's skill storage.

Web, desktop and mobile share management, update policies and results. Agents with full access can use `list_managed_skills`, `inspect_skill` and `manage_skills` on the same environment.
