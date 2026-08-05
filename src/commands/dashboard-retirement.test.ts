import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStopCommand } from './stop.js';
import { registerViewCommand } from './view.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('retired dashboard commands', () => {
  it('hides view and stop from top-level help', () => {
    const program = new Command().name('maestro');
    registerViewCommand(program);
    registerStopCommand(program);

    const help = program.helpInformation();

    expect(help).not.toMatch(/^ {2}view\b/m);
    expect(help).not.toMatch(/^ {2}stop\b/m);
  });

  it('accepts legacy view flags without starting the dashboard', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const program = new Command();
    registerViewCommand(program);

    await program.parseAsync([
      'node',
      'maestro',
      'view',
      '--port',
      '8080',
      '--host',
      '0.0.0.0',
      '--path',
      '.',
      '--no-browser',
      '--tui',
      '--dev',
    ]);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('retired and is disabled'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('maestro run brief'));
  });

  it('accepts legacy stop flags without touching running processes', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const program = new Command();
    registerStopCommand(program);

    await program.parseAsync(['node', 'maestro', 'stop', '--port', '8080', '--force']);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('retired and is disabled'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('backward compatibility'));
  });
});
