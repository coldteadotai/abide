# Local Pi extension

Build Abide before loading the extension:

```sh
pnpm install
pnpm build
pi --no-extensions --extension ./packages/cli/dist/pi/extension.js
```

This command loads only the Abide extension. Omit `--no-extensions` to keep your other Pi extensions enabled.

For project-local discovery, create `.pi/extensions/abide.js` with:

```js
export { default } from "../../packages/cli/dist/pi/extension.js";
```

After you trust the project, a normal `pi` launch discovers this entry point. Use `pi --approve` for a one-off trusted run. Installation through `abide init` and package distribution are not part of this change.

The extension uses Abide's existing key lookup and rubric. It snapshots each user task, checks successful local edits and writes, and checks the complete diff before Pi settles. Repair continuations keep the original task snapshot. A task gets at most one continuation for a final repair.

Advisories appear as UI notifications, or as non-context session entries in headless modes. Missing credentials, failed checks, and timeouts leave Pi usable. Code changes still go to TypeSafe or the configured gateway under your key.

Immediate checks skip unreadable files, symlink paths, oversized files, and overlapping mutations whose exact before/after state is uncertain. The final diff covers those changes when git can snapshot the working tree. Without git, shell-only changes cannot be checked through the per-file fallback.
