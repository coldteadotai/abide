import { Box, Text } from "ink";
import type { DriftRow, ReplayResult, RuleTally } from "../../lib/replay.js";
import { ms, usd } from "../../lib/ui.js";
import { Columns } from "../components/Columns.js";
import { Header } from "../components/Header.js";
import { Section } from "../components/Section.js";
import { glyph, palette } from "../theme.js";
import type { SkippedReplaySession } from "../../lib/replayCollection.js";

export type ReplayData = {
  root: string;
  host: string;
  sessions: number;
  skippedSessions: SkippedReplaySession[];
  edits: number;
  result: ReplayResult;
  drift: DriftRow[];
  tallies: RuleTally[];
  spendUsd: number;
  elapsedMs: number;
};

const percent = (rate: number): string => `${Math.round(rate * 100)}%`;

export function ReplayView({ data }: { data: ReplayData }) {
  const judged = data.result.edits.filter((e) => e.error === undefined);
  const broken = judged.filter((e) => e.verdicts.some((v) => v.band === "act"));
  const failed = data.result.edits.filter((e) => e.error !== undefined);
  const brokenTurns = data.result.turns.filter((t) => t.verdicts.some((v) => v.band === "act"));
  const rows = data.tallies.filter((t) => t.broken + t.flagged > 0);
  const noEditsJudged = judged.length === 0 && data.skippedSessions.length > 0;
  return (
    <Box flexDirection="column">
      <Header
        command="replay"
        where={data.root}
        note={`${data.host} ${glyph.dotSep} ${data.sessions} sessions ${glyph.dotSep} ${judged.length} edits judged ${glyph.dotSep} ${ms(data.elapsedMs)} ${glyph.dotSep} about ${usd(data.spendUsd)}`}
      />
      <Section
        title="What abide would have caught"
        aside={`${broken.length} of ${judged.length} edits, ${brokenTurns.length} of ${data.result.turns.length} turns`}
      >
        <Columns
          indent={2}
          columns={[
            { key: "label", label: "when", width: 20 },
            { key: "edits", label: "edits", width: 6, align: "right" },
            { key: "broken", label: "broken", width: 7, align: "right" },
            { key: "rate", label: "rate", width: 6, align: "right" },
          ]}
          rows={data.drift.map((d) => ({
            label: { text: d.label, color: palette.cloud },
            edits: { text: String(d.edits), color: palette.mist },
            broken: { text: String(d.broken), color: d.broken > 0 ? palette.rose : palette.mist },
            rate: { text: percent(d.rate), color: palette.cloud, bold: true },
          }))}
        />
      </Section>
      <Section
        title="By rule"
        aside={rows.length === 0 ? "nothing fired" : `${rows.length} rules fired`}
      >
        {rows.length === 0 ? (
          <Text color={noEditsJudged ? palette.amber : palette.sage}>
            {noEditsJudged ? glyph.dot : glyph.check}{" "}
            {noEditsJudged
              ? "No edits were judged"
              : "No edit or turn broke a rule above the act line."}
          </Text>
        ) : (
          <Columns
            indent={2}
            columns={[
              { key: "rule", label: "rule", width: 34 },
              { key: "phase", label: "phase", width: 5 },
              { key: "broken", label: "broken", width: 7, align: "right" },
              { key: "flagged", label: "uncertain", width: 9, align: "right" },
              { key: "of", label: "of", width: 6, align: "right" },
              { key: "example", label: "for example", keep: "tail" },
            ]}
            rows={rows.map((t) => ({
              rule: { text: t.rule, color: palette.cloud, bold: true },
              phase: { text: t.phase, color: palette.mist },
              broken: { text: String(t.broken), color: t.broken > 0 ? palette.rose : palette.mist },
              flagged: {
                text: String(t.flagged),
                color: t.flagged > 0 ? palette.amber : palette.mist,
              },
              of: { text: String(t.of), color: palette.ash },
              example: { text: t.example, color: palette.ash },
            }))}
          />
        )}
      </Section>
      {failed.length > 0 ? (
        <Text color={palette.amber}>
          {failed.length} edits could not be judged: {failed[0]?.error}
        </Text>
      ) : null}
      {data.skippedSessions.length > 0 ? (
        <Text color={palette.amber}>
          Skipped {data.skippedSessions.length}{" "}
          {data.skippedSessions.length === 1 ? "session" : "sessions"}. Results cover only the
          sessions that could be read.
        </Text>
      ) : null}
      <Text color={palette.ash}>
        Jev is the judge here, so this is what abide would have flagged, not ground truth.
        Shell-made changes are not in a transcript and were not judged.
      </Text>
    </Box>
  );
}
