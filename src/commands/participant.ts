import type { Command } from 'commander';

import {
  participantStatus,
  registerParticipant,
  unregisterParticipant,
  type ParticipantMutationResult,
} from '../run/v3/participants.js';
import { emitV3Error, emitV3Success, v3Store } from './v3-cli-shared.js';

interface ParticipantReadOptions {
  session: string;
  participant?: string;
  actor?: string;
  requestId?: string;
  json?: boolean;
  workflowRoot: string;
}

interface ParticipantMutationOptions extends ParticipantReadOptions {
  participant: string;
  actor: string;
  requestId: string;
}

function addParticipantOptions(command: Command, mutation: boolean): Command {
  command.requiredOption('--session <id>', 'exact Session ID');
  if (mutation) {
    command.requiredOption('--participant <id>', 'source-window participant ID');
    command.requiredOption('--actor <id>', 'actor identity');
    command.requiredOption('--request-id <id>', 'idempotency request ID');
  } else {
    command.option('--participant <id>', 'filter by source-window participant ID');
    command.option('--actor <id>', 'filter by actor identity');
    command.option('--request-id <id>', 'response correlation request ID');
  }
  return command
    .option('--json', 'emit run-response/1.2 JSON')
    .option('--workflow-root <path>', 'project root containing .workflow', process.cwd());
}

function mutationResult(result: ParticipantMutationResult) {
  return {
    outcome: result.outcome,
    participant: result.participant,
  };
}

export function registerParticipantCommand(program: Command): void {
  const participant = program.command('participant').description('Manage session/3.0 source-window identities');

  addParticipantOptions(participant.command('register').description('Register a source-window identity'), true)
    .action((options: ParticipantMutationOptions) => {
      try {
        const result = registerParticipant(v3Store(options), {
          sessionId: options.session,
          participantId: options.participant,
          actorId: options.actor,
          requestId: options.requestId,
        });
        emitV3Success({
          operation: 'participant-register',
          sessionId: options.session,
          requestId: options.requestId,
          result: mutationResult(result),
        });
      } catch (error) {
        emitV3Error('participant-register', error, {
          session: options.session,
          requestId: options.requestId,
        });
      }
    });

  addParticipantOptions(participant.command('status').description('Read participant identities'), false)
    .action((options: ParticipantReadOptions) => {
      try {
        const status = participantStatus(v3Store(options), options.session);
        const filtered = {
          ...status,
          participants: status.participants.filter(item => (
            (options.participant === undefined || item.participant_id === options.participant)
            && (options.actor === undefined || item.actor_id === options.actor)
          )),
        };
        emitV3Success({
          operation: 'participant-status',
          sessionId: options.session,
          requestId: options.requestId,
          result: filtered,
        });
      } catch (error) {
        emitV3Error('participant-status', error, {
          session: options.session,
          requestId: options.requestId,
        });
      }
    });

  addParticipantOptions(participant.command('unregister').description('Unregister a source-window identity'), true)
    .action((options: ParticipantMutationOptions) => {
      try {
        const result = unregisterParticipant(v3Store(options), {
          sessionId: options.session,
          participantId: options.participant,
          actorId: options.actor,
          requestId: options.requestId,
        });
        emitV3Success({
          operation: 'participant-unregister',
          sessionId: options.session,
          requestId: options.requestId,
          result: mutationResult(result),
        });
      } catch (error) {
        emitV3Error('participant-unregister', error, {
          session: options.session,
          requestId: options.requestId,
        });
      }
    });
}
