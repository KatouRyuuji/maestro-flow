// ---------------------------------------------------------------------------
// Statusline enablement for the interactive install flow.
//
// Final write requires Claude Code selected AND both UI switches true:
//   1. Hub enabledSteps.statusline (space)
//   2. Config-page installStatusline (y/n)
// ---------------------------------------------------------------------------

/** Full interactive install defaults appearance ON. Subcommand only if listed. */
export function defaultStatuslineEnabled(initialStepIds?: string[]): boolean {
  if (initialStepIds) return initialStepIds.includes('statusline');
  return true;
}

/** Hub space and config-page y/n stay in lockstep. */
export function syncStatuslineSwitches(enabled: boolean): {
  hubEnabled: boolean;
  configEnabled: boolean;
} {
  return { hubEnabled: enabled, configEnabled: enabled };
}

/** Statusline is written only when Claude is selected and both switches are on. */
export function shouldInstallStatusline(opts: {
  claudeSelected: boolean;
  hubEnabled: boolean;
  configEnabled: boolean;
}): boolean {
  return opts.claudeSelected && opts.hubEnabled && opts.configEnabled;
}

export type StatuslineConfirmKind = 'install' | 'skipped' | 'omit';

/** Confirm page lists Statusline only when Claude Code is selected. */
export function statuslineConfirmKind(opts: {
  claudeSelected: boolean;
  willInstall: boolean;
}): StatuslineConfirmKind {
  if (!opts.claudeSelected) return 'omit';
  return opts.willInstall ? 'install' : 'skipped';
}
