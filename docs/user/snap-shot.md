# After desktop SnapShots removal

Desktop window capture has been removed. You can still open screenshots already attached to conversations.

## Remove an old Linux capture shortcut

If you set up a capture shortcut in Niri or Hyprland, remove the binding from the user config file you used during setup. Back up that file first. Remove only the binding that calls T3 Code's capture action, not other bindings that use the same keys:

- **Niri:** In `~/.config/niri/config.kdl` (or the file set by `NIRI_CONFIG`), find the entry inside `binds` that calls `com.t3tools.SnapShot.Capture` with `com.t3tools.T3Code.SnapShot` as the destination. Remove that entry, including its action block, and leave the enclosing `binds` block intact.
- **Hyprland / Omarchy:** Look in `~/.config/hypr/` for `bindings.conf`, `hyprland.conf`, `bindings.lua`, or `hyprland.lua`. Remove the `bind =` entry or `hl.bind(...)` call targeting `com.t3tools.T3Code:capture-window`, then run `hyprctl reload` in your Hyprland session.

If you set `XDG_CONFIG_HOME`, look there instead of `~/.config`. If you chose a different file during setup, check that file instead. Don't restore an entire old config backup to remove one shortcut; it may overwrite later edits.

## Recover a screenshot that never reached a draft

On the computer where you captured it, open `~/.t3/userdata/snap-shots` in your file manager. If you launched the desktop app with `T3CODE_HOME`, look in `$T3CODE_HOME/userdata/snap-shots` instead.

Preview the saved `.png` files to find the image you want, then [attach it to a draft](./composer.md#attach-files). Attach only the PNG, not its matching `.json` file. This recovers the image as a regular attachment without the old window metadata.
