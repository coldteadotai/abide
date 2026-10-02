# @coldtea/abide

The `abide` command and the hook script. Abide makes your coding agent abide by the rules in your own AGENTS.md, on every edit, from outside the agent's context window.

```
npx @coldtea/abide login    # paste your TypeSafe key once
npx @coldtea/abide init     # hooks into every agent on this machine
```

For Pi, use `npx @coldtea/abide init pi` and restart Pi. Add `--project` to install into the repository; use `npx @coldtea/abide uninstall pi` with the same scope to remove it. `npx @coldtea/abide replay pi` checks recorded Pi sessions.

Everything else, including which agents are supported, what a check costs and how the rubric works, is in the [main README](https://github.com/coldteadotai/abide#readme).
