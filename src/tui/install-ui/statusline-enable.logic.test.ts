import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  defaultStatuslineEnabled,
  shouldInstallStatusline,
  statuslineConfirmKind,
  syncStatuslineSwitches,
} from './statusline-enable.logic.js';

describe('statusline-enable.logic', () => {
  describe('defaultStatuslineEnabled', () => {
    it('turns appearance on for a full interactive install', () => {
      assert.equal(defaultStatuslineEnabled(), true);
      assert.equal(defaultStatuslineEnabled(undefined), true);
    });

    it('ignores prior-install state — first global install with empty manifest still defaults on', () => {
      // Regression: Hub used to seed from prior.statusline (manifest/settings),
      // so a fresh install skipped appearance even though the user never opted out.
      assert.equal(defaultStatuslineEnabled(), true);
    });

    it('enables only when a subcommand lists statusline', () => {
      assert.equal(defaultStatuslineEnabled(['statusline']), true);
      assert.equal(defaultStatuslineEnabled(['hooks']), false);
      assert.equal(defaultStatuslineEnabled(['components', 'mcp']), false);
      assert.equal(defaultStatuslineEnabled([]), false);
    });
  });

  describe('syncStatuslineSwitches', () => {
    it('sets Hub space and config y/n to the same value', () => {
      assert.deepEqual(syncStatuslineSwitches(true), {
        hubEnabled: true,
        configEnabled: true,
      });
      assert.deepEqual(syncStatuslineSwitches(false), {
        hubEnabled: false,
        configEnabled: false,
      });
    });
  });

  describe('shouldInstallStatusline', () => {
    it('installs when Claude is selected and both switches are on', () => {
      assert.equal(shouldInstallStatusline({
        claudeSelected: true,
        hubEnabled: true,
        configEnabled: true,
      }), true);
    });

    it('skips when Hub is on but config y/n is still off', () => {
      assert.equal(shouldInstallStatusline({
        claudeSelected: true,
        hubEnabled: true,
        configEnabled: false,
      }), false);
    });

    it('skips when config y/n is on but Hub is still off', () => {
      assert.equal(shouldInstallStatusline({
        claudeSelected: true,
        hubEnabled: false,
        configEnabled: true,
      }), false);
    });

    it('does not write statusline when Claude is not selected', () => {
      assert.equal(shouldInstallStatusline({
        claudeSelected: false,
        hubEnabled: true,
        configEnabled: true,
      }), false);
    });

    it('skips when every gate is off', () => {
      assert.equal(shouldInstallStatusline({
        claudeSelected: false,
        hubEnabled: false,
        configEnabled: false,
      }), false);
    });
  });

  describe('statuslineConfirmKind', () => {
    it('shows the selected theme when Claude is selected and install is on', () => {
      assert.equal(statuslineConfirmKind({ claudeSelected: true, willInstall: true }), 'install');
    });

    it('shows Skipped when Claude is selected but appearance is off', () => {
      assert.equal(statuslineConfirmKind({ claudeSelected: true, willInstall: false }), 'skipped');
    });

    it('omits Statusline from confirm when Claude is not selected', () => {
      assert.equal(statuslineConfirmKind({ claudeSelected: false, willInstall: false }), 'omit');
      assert.equal(statuslineConfirmKind({ claudeSelected: false, willInstall: true }), 'omit');
    });
  });
});
