import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { C, SYM, SP, SectionHeader, KeyHints } from '../shared/index.js';
import type { EntryStepInfo } from '../../core/entry-command-generator.js';

// ---------------------------------------------------------------------------
// EntryCommandsConfig — multi-select picker for entry command step generation
//
// Shows all eligible steps (prepare/<step>.md + workflows/<step>.md exist).
// Selected steps will have slash-command wrappers generated on install.
// ---------------------------------------------------------------------------

interface EntryCommandsConfigProps {
  eligibleSteps: EntryStepInfo[];
  selectedSteps: string[];
  onSelectionChange: (steps: string[]) => void;
  onDone: () => void;
}

export function EntryCommandsConfig({
  eligibleSteps,
  selectedSteps,
  onSelectionChange,
  onDone,
}: EntryCommandsConfigProps) {
  const [cursor, setCursor] = useState(0);
  const count = eligibleSteps.length;
  const safeIndex = Math.max(0, Math.min(cursor, count - 1));

  const toggle = useCallback(
    (step: string) => {
      onSelectionChange(
        selectedSteps.includes(step)
          ? selectedSteps.filter((s) => s !== step)
          : [...selectedSteps, step],
      );
    },
    [selectedSteps, onSelectionChange],
  );

  useInput((input, key) => {
    if (key.return) { onDone(); return; }
    if (key.upArrow) { setCursor((i) => (i - 1 + count) % count); return; }
    if (key.downArrow) { setCursor((i) => (i + 1) % count); return; }
    if (input === ' ') { toggle(eligibleSteps[safeIndex].step); return; }
    if (input === 'a' || input === 'A') { onSelectionChange(eligibleSteps.map((s) => s.step)); return; }
    if (input === 'n' || input === 'N') { onSelectionChange([]); return; }
    const num = parseInt(input, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= count) {
      toggle(eligibleSteps[num - 1].step);
    }
  });

  return (
    <Box flexDirection="column">
      <SectionHeader title="Entry Commands — Step Selection" />
      <Box marginTop={SP.sectionGap}>
        <Text color={C.neutral}>
          Generate slash-command wrappers (maestro run thin entries) for selected steps.
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {eligibleSteps.map((info, i) => {
          const selected = selectedSteps.includes(info.step);
          const hl = i === safeIndex;
          return (
            <Box key={info.step}>
              <Text color={hl ? C.primary : C.neutral}>[{i + 1}]</Text>
              <Text color={selected ? (hl ? C.successBright : C.success) : C.neutral}>
                {' '}{selected ? SYM.checkOn : SYM.checkOff}{' '}
              </Text>
              <Text color={hl ? C.primary : undefined} bold={hl}>
                {info.step.padEnd(16)}
              </Text>
              <Text color={C.neutral}>{info.description.slice(0, 60)}</Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Selected: {selectedSteps.length}/{count}</Text>
        {selectedSteps.length > 0 && (
          <Text dimColor>  ({selectedSteps.join(', ')})</Text>
        )}
      </Box>
      <KeyHints hints={`[Space/1-${count}] Toggle  [A]ll  [N]one  [Enter] Done`} />
    </Box>
  );
}
