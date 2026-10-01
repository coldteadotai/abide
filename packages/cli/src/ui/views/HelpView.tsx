import { Box, Text } from "ink";
import { Header } from "../components/Header.js";
import { palette } from "../theme.js";

const COMMANDS: [string, string][] = [
  ["login", "store your TypeSafe or Vercel AI Gateway key, for you or for this repo, owner-only"],
  ["init [agent] [--project]", "install into claude, codex, opencode, pi, or every one found here"],
  ["compile [--agent claude|pi]", "compile the rubric now, in a headless agent turn"],
  ["tune [--agent claude|pi]", "rewrite rules that never fire; --global tunes global rules"],
  ["rubric validate [--global]", "check .abide/rubric.json and fill in source hashes"],
  ["calibrate [--global]", "test every rule against this repo's recent history"],
  ["check [paths] [--all]", "check uncommitted changes the way the hooks would"],
  ["audit [paths] [--all]", "judge every file in scope as if just written; what breaks which rule"],
  ["report", "what is compiled, what fired, what never fires"],
  [
    "replay <agent>",
    "judge past claude, codex, opencode or pi sessions in this repo as if abide had been installed",
  ],
  ["bench [--runs N]", "latency and spend, measured on this machine"],
  ["uninstall [agent] [--project]", "remove the hooks from one agent, or all"],
];

export function HelpView() {
  return (
    <Box flexDirection="column">
      <Header
        command="help"
        note="Enforce your own AGENTS.md rules on every edit a coding agent makes."
      />
      {COMMANDS.map(([name, what]) => (
        <Box key={name}>
          <Box width={30}>
            <Text color={palette.cloud} bold>
              {name}
            </Text>
          </Box>
          <Text color={palette.mist}>{what}</Text>
        </Box>
      ))}
      <Box marginTop={1} flexDirection="column">
        <Text color={palette.ash}>
          --json prints machine-readable output on report, check, audit, bench and calibrate.
        </Text>
        <Text color={palette.ash}>
          Key: abide login, or TYPESAFE_AI_API_KEY (or AI_GATEWAY_API_KEY) in the environment or a
          .env.local or .env at the repo root.
        </Text>
      </Box>
    </Box>
  );
}
