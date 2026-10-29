export const WORKSPACE_STORAGE_KEY = 'logicweb.workspace';
export const WORKSPACE_SCHEMA_VERSION = 1 as const;

export interface WorkspaceSnapshotV1 {
  version: typeof WORKSPACE_SCHEMA_VERSION;
  detailedLabels: boolean;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWorkspaceSnapshot(raw: string | null): WorkspaceSnapshotV1 | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== WORKSPACE_SCHEMA_VERSION) return null;
  return {
    version: WORKSPACE_SCHEMA_VERSION,
    detailedLabels: typeof parsed.detailedLabels === 'boolean' ? parsed.detailedLabels : true,
  };
}

export function readWorkspaceSnapshot(): WorkspaceSnapshotV1 | null {
  try {
    return parseWorkspaceSnapshot(storage()?.getItem(WORKSPACE_STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

export function serializeWorkspaceSnapshot(snapshot: WorkspaceSnapshotV1): string {
  return JSON.stringify({
    version: WORKSPACE_SCHEMA_VERSION,
    detailedLabels: snapshot.detailedLabels,
  });
}

export function writeWorkspaceSnapshot(snapshot: WorkspaceSnapshotV1): boolean {
  try {
    const store = storage();
    if (store === null) return false;
    store.setItem(WORKSPACE_STORAGE_KEY, serializeWorkspaceSnapshot(snapshot));
    return true;
  } catch {
    return false;
  }
}
