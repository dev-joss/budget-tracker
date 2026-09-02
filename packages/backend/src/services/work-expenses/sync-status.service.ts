import type { ExpensifySyncStatus, RecordId } from '@bt/shared/types';
import ExpensifyConnections from '@models/expensify-connections.model';
import { redisClient } from '@root/redis-client';
import { Op } from 'sequelize';

const STATUS_TTL_SECONDS = 24 * 60 * 60;

export interface SynchronizationScope {
  connectionId: RecordId;
  credentialRevision: number;
}

export interface SynchronizationOwner extends SynchronizationScope {
  synchronizationRunId: RecordId;
}

interface SynchronizationStatusEnvelope extends SynchronizationScope {
  status: Exclude<ExpensifySyncStatus, { status: 'idle' }>;
}

const buildSynchronizationStatusKey = ({ userId }: { userId: number }): string =>
  `work-expenses-sync-status-${userId}`;

export const buildSynchronizationLockKey = ({ userId }: { userId: number }): string =>
  `work-expenses-sync-lock-${userId}`;

const WRITE_STATUS_IF_LOCK_OWNED = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call("set", KEYS[2], ARGV[2], "EX", ARGV[3])
return 1`;

const CLEAR_SYNCHRONIZATION_STATE_IF_OWNED = `
local run_id = ARGV[3]
if run_id ~= "" and redis.call("get", KEYS[1]) == run_id then
  redis.call("del", KEYS[1])
end

local raw_status = redis.call("get", KEYS[2])
if not raw_status then
  return 0
end

local ok, decoded = pcall(cjson.decode, raw_status)
if not ok or type(decoded) ~= "table" then
  return 0
end

local status_run_id = nil
if type(decoded.status) == "table" then
  status_run_id = decoded.status.runId
else
  status_run_id = decoded.runId
end

local scope_matches = decoded.connectionId == ARGV[1]
  and tostring(decoded.credentialRevision) == ARGV[2]
local run_matches = run_id == "" or status_run_id == run_id
if scope_matches and run_matches then
  return redis.call("del", KEYS[2])
end
return 0`;

export async function writeSynchronizationStatus({
  userId,
  owner,
  status,
}: {
  userId: number;
  owner: SynchronizationOwner;
  status: Exclude<ExpensifySyncStatus, { status: 'idle' }>;
}): Promise<boolean> {
  const envelope: SynchronizationStatusEnvelope = {
    connectionId: owner.connectionId,
    credentialRevision: owner.credentialRevision,
    status,
  };
  const written = await redisClient.eval(
    WRITE_STATUS_IF_LOCK_OWNED,
    2,
    buildSynchronizationLockKey({ userId }),
    buildSynchronizationStatusKey({ userId }),
    owner.synchronizationRunId,
    JSON.stringify(envelope),
    STATUS_TTL_SECONDS,
  );
  return written === 1;
}

export function parseSynchronizationStatus({ raw }: { raw: string }): ExpensifySyncStatus {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return { status: 'idle' };
    const candidate = 'connectionId' in parsed ? (parsed as Partial<SynchronizationStatusEnvelope>).status : parsed;
    if (!candidate || typeof candidate !== 'object' || !('status' in candidate)) {
      return { status: 'idle' };
    }
    const status = candidate as ExpensifySyncStatus;
    if (!['queued', 'processing', 'completed', 'failed'].includes(status.status)) {
      return { status: 'idle' };
    }
    return status;
  } catch {
    return { status: 'idle' };
  }
}

export function parseSynchronizationStatusEnvelope({ raw }: { raw: string }): SynchronizationStatusEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SynchronizationStatusEnvelope>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.connectionId !== 'string' ||
      typeof parsed.credentialRevision !== 'number' ||
      !parsed.status ||
      parseSynchronizationStatus({ raw }).status === 'idle'
    ) {
      return null;
    }
    return parsed as SynchronizationStatusEnvelope;
  } catch {
    return null;
  }
}

export function synchronizationStatusBelongsToConnection({
  envelope,
  connection,
}: {
  envelope: SynchronizationStatusEnvelope;
  connection: { activeSynchronizationRunId: RecordId | null } | null;
}): boolean {
  if (!connection) return false;
  const runIsActive = connection.activeSynchronizationRunId === envelope.status.runId;
  if (envelope.status.status === 'queued' || envelope.status.status === 'processing') return runIsActive;
  return connection.activeSynchronizationRunId === null || runIsActive;
}

export async function getSynchronizationStatus({ userId }: { userId: number }): Promise<ExpensifySyncStatus> {
  const raw = await redisClient.get(buildSynchronizationStatusKey({ userId }));
  if (!raw) return { status: 'idle' };
  const envelope = parseSynchronizationStatusEnvelope({ raw });
  if (!envelope) return { status: 'idle' };

  const connection = await ExpensifyConnections.unscoped().findOne({
    where: {
      id: envelope.connectionId,
      userId,
      credentialRevision: envelope.credentialRevision,
      encryptedCredentials: { [Op.not]: null },
    },
    attributes: ['id', 'activeSynchronizationRunId'],
  });
  if (synchronizationStatusBelongsToConnection({ envelope, connection })) {
    return envelope.status;
  }

  await clearSynchronizationStateIfOwned({
    userId,
    scope: envelope,
    synchronizationRunId: envelope.status.runId,
  });
  return { status: 'idle' };
}

export async function clearSynchronizationStateIfOwned({
  userId,
  scope,
  synchronizationRunId,
}: {
  userId: number;
  scope: SynchronizationScope;
  synchronizationRunId: RecordId | null;
}): Promise<void> {
  await redisClient.eval(
    CLEAR_SYNCHRONIZATION_STATE_IF_OWNED,
    2,
    buildSynchronizationLockKey({ userId }),
    buildSynchronizationStatusKey({ userId }),
    scope.connectionId,
    scope.credentialRevision,
    synchronizationRunId ?? '',
  );
}
