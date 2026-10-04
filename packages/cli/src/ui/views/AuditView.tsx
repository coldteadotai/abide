import { Box, Text } from "ink";
import type { Verdict } from "@coldtea/abide-schema";
import { ms, usd } from "../../lib/ui.js";
import { Header } from "../components/Header.js";
import { Callout } from "../components/Callout.js";
import { Columns } from "../components/Columns.js";
import { Section } from "../components/Section.js";
import { glyph, meter, palette } from "../theme.js";
import type { AuditSkipped, AuditFileResult, RuleTally } from "../../lib/audit.js";

export type AuditData = {
  root: string;
  files: number;
  skipped: AuditSkipped;
  results: AuditFileResult[];
  tallies: RuleTally[];
  spendUsd: number;
  elapsedMs: number;
  all: boolean;
};

const worst = (r: AuditFileResult): Verdict | undefined =>
  [...r.verdicts].sort((a, b) => b.probability - a.probability)[0];

export function AuditView({ data }: { data: AuditData }) {
  const broken = data.results.filter((r) => r.verdicts.some((v) => v.band === "act"));
  const flaggedOnly = data.results.filter(
    (r) => !r.verdicts.some((v) => v.band === "act") && r.verdicts.some((v) => v.band === "flag"),
  );
  const failed = data.results.filter((r) => r.error !== undefined);
  const rows = data.tallies.filter((t) => data.all || t.broken.length + t.flagged.length > 0);
  const fileRows = [...broken, ...(data.all ? flaggedOnly : [])].sort(
    (a, b) => (worst(b)?.probability ?? 0) - (worst(a)?.probability ?? 0),
  );
  const skipped = [
    data.skipped.outOfScope
      ? `${data.skipped.outOfScope} ${data.skipped.outOfScope === 1 ? "file" : "files"} no rule applies to`
      : "",
    data.skipped.tooBig.length ? `${data.skipped.tooBig.length} too big to send` : "",
    data.skipped.binary.length
      ? `${data.skipped.binary.length} binary ${data.skipped.binary.length === 1 ? "file" : "files"}`
      : "",
  ]
    .filter(Boolean)
    .join(" and ");
  return (
    <Box flexDirection="column">
      <Header
        command="audit"
        where={data.root}
        note={`${data.files} files judged ${glyph.dotSep} ${ms(data.elapsedMs)} ${glyph.dotSep} about ${usd(data.spendUsd)}`}
      />
      <Section
        title="By rule"
        aside={
          rows.length === 0
            ? "nothing broken"
            : `${rows.length} ${rows.length === 1 ? "rule" : "rules"} with something to look at`
        }
      >
        {rows.length === 0 ? (
          <Text color={palette.sage}>{glyph.check} No file breaks a rule above the act line.</Text>
        ) : (
          <Columns
            indent={2}
            columns={[
              { key: "rule", label: "rule", width: 34 },
              { key: "broken", label: "broken", width: 7, align: "right" },
              { key: "flagged", label: "uncertain", width: 9, align: "right" },
              { key: "checked", label: "of", width: 5, align: "right" },
              { key: "example", label: "for example", keep: "tail" },
            ]}
            rows={rows.map((t) => ({
              rule: {
                text: t.ruleId,
                color: t.broken.length > 0 ? palette.cloud : palette.mist,
                bold: t.broken.length > 0,
              },
              broken: {
                text: String(t.broken.length),
                color: t.broken.length > 0 ? palette.rose : palette.ash,
                bold: t.broken.length > 0,
              },
              flagged: {
                text: String(t.flagged.length),
                color: t.flagged.length > 0 ? palette.amber : palette.ash,
              },
              checked: { text: String(t.checked), color: palette.ash },
              example: { text: t.broken[0] ?? t.flagged[0] ?? "", color: palette.mist },
            }))}
          />
        )}
      </Section>
      {fileRows.length > 0 ? (
        <Section
          title="By file"
          aside={`${broken.length} ${broken.length === 1 ? "file breaks" : "files break"} a rule ${glyph.dotSep} ${flaggedOnly.length} uncertain only`}
        >
          {fileRows.slice(0, data.all ? fileRows.length : 40).map((r) => {
            const top = worst(r);
            const acts = r.verdicts.filter((v) => v.band === "act").map((v) => v.ruleId);
            const flags = r.verdicts.filter((v) => v.band === "flag").map((v) => v.ruleId);
            return (
              <Box key={r.file} flexDirection="column">
                <Box>
                  <Text color={acts.length ? palette.rose : palette.amber}>
                    {meter(top?.probability ?? 0, 6)}
                  </Text>
                  <Text color={palette.cloud} bold={acts.length > 0}>
                    {"  "}
                    {r.file}
                  </Text>
                </Box>
                <Box paddingLeft={8}>
                  <Text color={palette.ash} wrap="truncate-end">
                    {acts.length ? acts.join(", ") : ""}
                    {acts.length && flags.length ? "  " : ""}
                    {flags.length ? `uncertain: ${flags.join(", ")}` : ""}
                  </Text>
                </Box>
              </Box>
            );
          })}
          {!data.all && fileRows.length > 40 ? (
            <Text color={palette.ash}>{fileRows.length - 40} more. Pass --all to list them.</Text>
          ) : null}
        </Section>
      ) : null}
      {failed.length > 0 ? (
        <Callout
          tone="warn"
          title={`${failed.length} ${failed.length === 1 ? "file was" : "files were"} judged only in part, or not at all`}
        >
          {failed.slice(0, 5).map((r) => (
            <Text key={r.file} color={palette.mist}>
              {r.file} <Text color={palette.ash}>{r.error}</Text>
            </Text>
          ))}
        </Callout>
      ) : null}
      {skipped ? (
        <Text color={palette.ash}>
          Skipped {skipped}. Turn-phase rules do not apply to an audit.
        </Text>
      ) : null}
    </Box>
  );
}
