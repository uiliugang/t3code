# Skills

Open **Settings > Skills** and select an environment. Install from a local skill directory, a Git repository or URL, or an enabled Meituan Skills source. Choose the agents that should receive the skill. Paths and installers belong to the selected environment, including when connecting remotely.

The source badge identifies where each skill was installed from. Expand its details to see the installer, versions and linked agent directories. Existing skills remain unmanaged until explicitly imported; importing does not replace their original directories. Remove or move a conflicting directory yourself before linking there.

Use **Sources** to enable a platform, set its installer executable and npm registry, or prepare its installer on the environment. Meituan Skills is optional and requires access to its registry and any authentication its installer needs. **Targets** adds agent directories that are not detected automatically, including custom skill platforms.

Update policies are Manual, Check daily, Update daily and Pinned. Daily checks run while the T3 server is running. Checking downloads a candidate without activating it. Updates wait for running agents to finish; removing or changing links requires idle agents. Restoring an earlier version pins it to prevent automatic replacement. A running provider may need a new thread to reload its skills.

Web and desktop provide source and custom target configuration. Mobile supports installation, source enablement, updates, rollback and agent selection. Agents with full access can use `list_managed_skills` and `manage_skills` on the same environment.
