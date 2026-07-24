export const LIFECYCLE_FS_HELPER_PROTOCOL = 'lifecycle-fs-helper/1.0' as const;
export const LIFECYCLE_FS_GENERATION_SCHEMA = 'lifecycle-fs-generation/1.0' as const;

export interface PosixIdentity {
  kind: 'posix';
  dev: string;
  ino: string;
  mode: number;
}

export interface WindowsIdentity {
  kind: 'windows';
  volumeSerial: string;
  fileId128: string;
  fileAttributes: number;
  reparseTag: number | null;
}

export type PlatformIdentity = PosixIdentity | WindowsIdentity;

export interface LifecycleGeneration {
  schema_version: 'lifecycle-fs-generation/1.0';
  platform: 'windows' | 'posix';
  root: PlatformIdentity;
  parentChain: PlatformIdentity[];
  entry: PlatformIdentity;
  sha256: string;
  ownerGeneration: string | null;
}

export interface BoundRead {
  bytesBase64: string;
  generation: LifecycleGeneration;
}

export interface BoundLock {
  lockRelativePath: string;
  token: string;
  ownerGeneration: string;
  generation: LifecycleGeneration;
}

export interface BoundQuarantine {
  originalRelativePath: string;
  quarantineRelativePath: string;
  requestId: string;
  ownerGeneration: string;
  expectedSha256: string;
  generation: LifecycleGeneration;
}

interface HelperRequestBase {
  protocol: 'lifecycle-fs-helper/1.0';
  requestId: string;
  projectRoot: string;
}

export interface ReadRequest extends HelperRequestBase {
  op: 'read';
  relativePath: string;
}

export interface ReplaceRequest extends HelperRequestBase {
  op: 'replace';
  relativePath: string;
  bytesBase64: string;
  expected: LifecycleGeneration | null;
  ownerGeneration: string;
}

export interface AcquireLockRequest extends HelperRequestBase {
  op: 'acquire-lock';
  lockRelativePath: string;
  owner: {
    pid: number;
    token: string;
    ownerGeneration: string;
  };
  staleAfterMs: number;
}

export interface QuarantineRequest extends HelperRequestBase {
  op: 'quarantine-if-hash';
  relativePath: string;
  expectedSha256: string;
  requestIdToRestore: string;
  ownerGeneration: string;
}

export interface RecoverQuarantineRequest extends HelperRequestBase {
  op: 'recover-quarantine';
  quarantine: BoundQuarantine;
  decision: 'restore' | 'commit';
}

export interface ReleaseLockRequest extends HelperRequestBase {
  op: 'compare-release-lock';
  lock: BoundLock;
}

export type HelperRequest =
  | ReadRequest
  | ReplaceRequest
  | AcquireLockRequest
  | QuarantineRequest
  | RecoverQuarantineRequest
  | ReleaseLockRequest;

export interface HelperSuccess<T> {
  protocol: 'lifecycle-fs-helper/1.0';
  requestId: string;
  ok: true;
  result: T;
}

export type HelperFailureCode =
  | 'UNSAFE_PATH'
  | 'UNSUPPORTED'
  | 'MISSING'
  | 'REPLACED'
  | 'BUSY'
  | 'HASH_MISMATCH'
  | 'NATIVE_ERROR';

export interface HelperFailure {
  protocol: 'lifecycle-fs-helper/1.0';
  requestId: string;
  ok: false;
  code: HelperFailureCode;
  nativeStatus: string | null;
  message: string;
}

export type HelperResponse<T> = HelperSuccess<T> | HelperFailure;

export declare function readLifecycleFileBound(
  projectRoot: string,
  relativePath: string,
): BoundRead;

export declare function replaceLifecycleFileBound(
  projectRoot: string,
  relativePath: string,
  bytes: Buffer,
  expected: LifecycleGeneration | null,
  ownerGeneration: string,
): LifecycleGeneration;

export declare function acquireLifecycleLockBound(
  projectRoot: string,
  lockRelativePath: string,
  owner: { pid: number; token: string; ownerGeneration: string },
  staleAfterMs: number,
): BoundLock;

export declare function quarantineLifecycleFileBound(
  projectRoot: string,
  relativePath: string,
  expectedSha256: string,
  requestId: string,
  ownerGeneration: string,
): BoundQuarantine;

export declare function recoverLifecycleQuarantineBound(
  projectRoot: string,
  quarantine: BoundQuarantine,
  decision: 'restore' | 'commit',
): 'restored' | 'committed' | 'replaced';

export declare function compareReleaseLifecycleLock(
  projectRoot: string,
  lock: BoundLock,
): 'released' | 'missing' | 'replaced';

