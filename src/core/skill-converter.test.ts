import { describe, expect, it } from 'vitest';
import { transformContentForPlatform } from './skill-converter.js';

describe('Pi Maestro platform conversion', () => {
  it('binds platform on Session and Run creation and content-loading commands', () => {
    const source = [
      'maestro session create "topic" --id demo --chain-file chain.json',
      'maestro session start "topic" --chain analyze execute',
      'maestro run start "goal" --cmd companion',
      'maestro run create plan --session demo --arg "change"',
      'maestro run prepare analyze --session demo',
      'maestro run skill analyze',
      'maestro run brief run-1 --session demo',
    ].join('\n');

    const converted = transformContentForPlatform(source, 'pi');

    expect(converted).toContain('maestro session create --platform pi "topic"');
    expect(converted).toContain('maestro session start --platform pi "topic"');
    expect(converted).toContain('maestro run start --platform pi "goal"');
    expect(converted).toContain('maestro run create --platform pi plan');
    expect(converted).toContain('maestro run prepare --platform pi analyze');
    expect(converted).toContain('maestro run skill --platform pi analyze');
    expect(converted).toContain('maestro run brief --platform pi run-1');
  });

  it('rewrites canonical platform placeholders and Claude bindings to Pi', () => {
    const source = [
      'maestro skills --steps --json --platform {target_platform}',
      'maestro session create "topic" --platform {target_platform} --chain analyze',
      'maestro session start "topic" --platform claude --chain analyze',
      'maestro run create plan --platform {target_platform} --session demo',
      'maestro run brief run-1 --platform claude',
    ].join('\n');

    const converted = transformContentForPlatform(source, 'pi');

    expect(converted).not.toContain('{target_platform}');
    expect(converted).not.toContain('--platform claude');
    expect(converted.match(/--platform pi/g)).toHaveLength(5);
  });

  it('does not add platform to commands that consume the persisted binding', () => {
    const source = [
      'maestro session next --session demo',
      'maestro session status demo',
      'maestro session done run-1 --session demo',
      'maestro run check run-1 --session demo',
      'maestro run done run-1 --session demo',
    ].join('\n');

    const converted = transformContentForPlatform(source, 'pi');

    expect(converted).toBe(source);
  });

  it('preserves complete delegate prompts and maps Pi teammate options', () => {
    const prompt = `PURPOSE: ${'inspect delegated behavior '.repeat(8)}\nMODE: analysis`;
    const source = `maestro delegate "${prompt}" --mode analysis --rule analysis-analyze-code-patterns --cd src --id delegate-check`;

    const converted = transformContentForPlatform(source, 'pi');

    expect(converted).toContain(`task: "${prompt.replace(/\n/g, '\\n')}"`);
    expect(converted).toContain('taskType: "analysis"');
    expect(converted).toContain('prompt: "analysis-analyze-code-patterns"');
    expect(converted).toContain('cwd: "src"');
    expect(converted).toContain('name: "delegate-check"');
    expect(converted).not.toContain('…');
  });

  it('keeps an existing Pi binding idempotent', () => {
    const source = [
      'maestro session create "topic" --platform pi --chain analyze',
      'maestro run create plan --platform pi --session demo',
      'maestro run brief run-1 --platform pi',
    ].join('\n');

    const converted = transformContentForPlatform(source, 'pi');

    expect(converted).toBe(source);
    expect(converted.match(/--platform pi/g)).toHaveLength(3);
  });
});
